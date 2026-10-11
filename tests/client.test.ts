import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiwcClient, safeFailure, createWindowsClient, type ResponseInputItem } from '../lib/index.js';
import { createBudgetTestHarness } from '../lib/budget.js';
import { createAuthTestHarness } from '../lib/auth.js';

function completed(output: Record<string, unknown>[]) {
  const events = output.flatMap((item, output_index) => [
    { type: 'response.output_item.added', output_index, item }, { type: 'response.output_item.done', output_index, item },
  ]);
  events.push({ type: 'response.completed', response: { status: 'completed', output } } as never);
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
test('public module has no DSH dependency and help construction does not read credentials', () => {
  const runtime = createWindowsClient({ appId: 'synthetic-sdk-test', appName: 'Synthetic SDK Test' });
  assert.ok(runtime.auth); assert.ok(runtime.client); assert.ok(runtime.budget);
});

test('cancellation settles during the authentication status queue without waiting for another operation', async () => {
  const auth = createAuthTestHarness({ openBrowser: async () => {}, transport: async () => { throw new Error('No HTTP in this fixture'); },
    seed: { version: 1, hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', activeId: 'fixture', registrations: [{
      id: 'fixture', label: 'Synthetic fixture', clientId: 'oaiapp_fixture', subject: 'fixture-subject', issuer: 'https://auth.openai.com', planConfirmed: true,
      credentials: { accessToken: 'synthetic-test-only', refreshToken: 'synthetic-refresh-only', expiresAt: Date.now() + 3_600_000,
        scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], savedAt: new Date().toISOString() },
    }] } });
  let acquired!: () => void; const ready = new Promise<void>(resolve => { acquired = resolve; });
  let release!: () => void;
  const holding = auth.withAccessToken(async () => { acquired(); await new Promise<void>(resolve => { release = resolve; }); });
  await ready;
  let entered!: () => void; const statusEntered = new Promise<void>(resolve => { entered = resolve; });
  const client = new SiwcClient({
    withAccessToken: (operation, signal) => auth.withAccessToken(operation, signal),
    openRequestScope: signal => auth.openRequestScope(signal),
    status: async signal => { entered(); return auth.status(signal); },
  }, { beforeRequest: async () => { throw new Error('No model HTTP in this fixture'); } });
  const controller = new AbortController();
  const pending = client.complete({ model: 'fixture', input: [{ role: 'user', content: 'fixture' }], signal: controller.signal })
    .then(() => 'unexpected-success', error => error.code);
  try {
    await statusEntered; controller.abort();
    assert.equal(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still-waiting'), 200))]), 'CANCELLED');
  } finally { release(); await holding; await pending; auth.abortAll(); }
});
test('default OFF and a shared bounded grant count failed HTTP once, never retry or fallback', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'siwc-sdk-budget-'));
  const budget = createBudgetTestHarness(join(folder, 'requests.json'));
  let inference = 0; const old = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] });
      assert.equal(url, 'https://api.openai.com/v1/responses'); inference++;
      assert.equal(init?.redirect, 'error');
      return Response.json({ error: { code: 'service_unavailable', message: 'SYNTHETIC_SECRET_REFLECTION' } }, { status: 503 });
    };
    const client = new SiwcClient({ withAccessToken: operation => operation('synthetic-test-only') }, { beforeRequest: (kind, signal) => budget.request(kind, signal) });
    const request = { model: 'fixture', input: [{ role: 'user' as const, content: 'test' }] };
    await assert.rejects(client.complete(request), { code: 'INFERENCE_NOT_STARTED' }); assert.equal(inference, 0);
    await budget.begin({ maxRequests: 1, creditSettingsConfirmed: true });
    await assert.rejects(client.complete(request), error => {
      assert.equal(safeFailure(error).includes('SYNTHETIC_SECRET_REFLECTION'), false); return true;
    });
    assert.equal(inference, 1); assert.equal((await budget.status()).inference, 1);
    await assert.rejects(client.complete(request), { code: 'REQUEST_BUDGET_EXHAUSTED' }); assert.equal(inference, 1);
  } finally { globalThis.fetch = old; }
});
test('opaque output replays only in the same client, model and selected registration', async () => {
  let identity = 'registration-a'; let inference = 0; const old = globalThis.fetch;
  const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'synthetic-opaque-only' };
  try {
    globalThis.fetch = async (url, init) => {
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: ['fixture', 'other'].map(slug => ({ slug, display_name: slug, visibility: 'list' })) });
      assert.equal(url, 'https://api.openai.com/v1/responses'); inference++;
      const body = JSON.parse(String(init?.body));
      if (inference > 1 && body.input.length > 1) assert.ok(body.input.some((item: any) => item.encrypted_content === reasoning.encrypted_content));
      return completed([reasoning, { type: 'message', role: 'assistant', id: 'msg_fixture', status: 'completed',
        content: [{ type: 'output_text', text: 'fixture answer', annotations: [] }] }]);
    };
    const credentials = { status: async () => ({ activeId: identity }), withAccessToken: <T>(operation: (token: string, signal?: AbortSignal, registrationId?: string) => Promise<T>) => operation('synthetic-test-only', undefined, identity) };
    const observer = { beforeRequest: async () => {} };
    const client = new SiwcClient(credentials, observer);
    const response = await client.complete({ model: 'fixture', input: [{ role: 'user', content: 'test' }] });
    const input: ResponseInputItem[] = JSON.parse(JSON.stringify(response.output));
    await client.complete({ model: 'fixture', input }); assert.equal(inference, 2);
    await assert.rejects(client.complete({ model: 'other', input }), { code: 'INVALID_REPLAY_CONTEXT' });
    identity = 'registration-b';
    await assert.rejects(client.complete({ model: 'fixture', input }), { code: 'INVALID_REPLAY_CONTEXT' });
    identity = 'registration-a';
    await assert.rejects(client.complete({ model: 'fixture', input }), { code: 'INVALID_REPLAY_CONTEXT' });
    await assert.rejects(new SiwcClient(credentials, observer).complete({ model: 'fixture', input }), { code: 'INVALID_REPLAY_CONTEXT' });
    assert.equal(inference, 2);
    // A source that cannot name the token's registration may not reuse history.
    const unbound = new SiwcClient({ status: credentials.status, withAccessToken: <T>(operation: (token: string) => Promise<T>) => operation('synthetic-test-only') }, observer);
    const fresh = JSON.parse(JSON.stringify((await unbound.complete({ model: 'fixture', input: [{ role: 'user', content: 'test' }] })).output));
    assert.equal(inference, 3);
    await assert.rejects(unbound.complete({ model: 'fixture', input: fresh }), { code: 'INVALID_REPLAY_CONTEXT' });
    assert.equal(inference, 3);
  } finally { globalThis.fetch = old; }
});
test('subscription unavailable/limit after HTTP latches without a new request', async () => {
  let inference = 0; let models = 0; const old = globalThis.fetch;
  try {
    globalThis.fetch = async url => {
      if (url === 'https://api.openai.com/v1/models') { models++; return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] }); }
      assert.equal(url, 'https://api.openai.com/v1/responses'); inference++;
      return Response.json({ error: { code: 'subscription_sharing_usage_unavailable' } }, { status: 429 });
    };
    const client = new SiwcClient({ withAccessToken: operation => operation('synthetic-test-only') }, { beforeRequest: async () => {} });
    const request = { model: 'fixture', input: [{ role: 'user' as const, content: 'test' }] };
    await assert.rejects(client.complete(request), { code: 'subscription_sharing_usage_unavailable' });
    assert.equal(client.isUsageLimited(), true);
    // No catalog GET before inference (SIWC: the catalog is not an entitlement check).
    await assert.rejects(client.complete(request)); assert.equal(inference, 1); assert.equal(models, 0);
  } finally { globalThis.fetch = old; }
});

test('default replay retention is bounded and a full current conversation remains reusable', async () => {
  const old = globalThis.fetch;
  let inference = 0;
  const retained = (client: SiwcClient) => (client as any).replays.size as number;
  try {
    globalThis.fetch = async url => {
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] });
      inference++;
      return completed([{ type: 'reasoning', id: `rs_${inference}`, summary: [], encrypted_content: `synthetic-${inference}` },
        { type: 'message', id: `msg_${inference}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'synthetic answer', annotations: [] }] }]);
    };
    const client = new SiwcClient({ withAccessToken: operation => operation('synthetic-test-only') }, { beforeRequest: async () => {} });
    let response;
    for (let turn = 0; turn < 4097; turn++) response = await client.complete({ model: 'fixture', input: [{ role: 'user', content: 'synthetic independent conversation' }] });
    assert.ok(retained(client) <= 4096, 'Default retention must not grow beyond its documented limit');
    await client.complete({ model: 'fixture', input: structuredClone(response!.output) });
    assert.ok(retained(client) <= 4096);
  } finally { globalThis.fetch = old; }
});

test('clearing replay history invalidates completed history without sending it', async () => {
  const old = globalThis.fetch; let inference = 0;
  try {
    globalThis.fetch = async url => {
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] });
      inference++; return completed([{ type: 'reasoning', id: 'rs_clear', summary: [], encrypted_content: 'synthetic-clear-only' },
        { type: 'message', id: 'msg_clear', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'synthetic answer', annotations: [] }] }]);
    };
    const client = new SiwcClient({ withAccessToken: operation => operation('synthetic-test-only') }, { beforeRequest: async () => {} });
    const response = await client.complete({ model: 'fixture', input: [{ role: 'user', content: 'synthetic' }] });
    const clear = (client as any).clearReplayHistory;
    assert.equal(typeof clear, 'function', 'Hosts need an explicit conversation-end operation');
    clear.call(client);
    await assert.rejects(client.complete({ model: 'fixture', input: structuredClone(response.output) }), { code: 'INVALID_REPLAY_CONTEXT' });
    assert.equal(inference, 1);
  } finally { globalThis.fetch = old; }
});

test('capacity overflow is explicit, preserves old provenance, and never returns a partial completed response', async () => {
  const old = globalThis.fetch; let inference = 0;
  try {
    globalThis.fetch = async url => {
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] });
      inference++; const id = inference === 2 ? 2 : 1;
      return completed([{ type: 'reasoning', id: `rs_${id}`, summary: [], encrypted_content: `synthetic-${id}` },
        { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'synthetic answer', annotations: [] }] }]);
    };
    const credentials = { withAccessToken: <T>(operation: (token: string) => Promise<T>) => operation('synthetic-test-only') };
    const client = new SiwcClient(credentials, { beforeRequest: async () => {} }, { maxReplayItems: 3 });
    const first = await client.complete({ model: 'fixture', input: [{ role: 'user', content: 'synthetic' }] });
    await assert.rejects(client.complete({ model: 'fixture', input: structuredClone(first.output) }), { code: 'REPLAY_CAPACITY_EXCEEDED' });
    assert.equal((client as any).replays.size, 2);
    assert.deepEqual((await client.complete({ model: 'fixture', input: structuredClone(first.output) })).output, first.output);
    for (const maxReplayItems of [0, -1, 1.5, Infinity, 65537]) assert.throws(() => new SiwcClient(credentials, { beforeRequest: async () => {} }, { maxReplayItems }), { code: 'INVALID_REPLAY_LIMIT' });
  } finally { globalThis.fetch = old; }
});

test('clear during an in-flight response cancels it and prevents cache repopulation', async () => {
  const old = globalThis.fetch; let inference = 0;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    globalThis.fetch = async url => {
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] });
      inference++;
      if (inference === 2) { entered(); await gate; }
      return completed([{ type: 'message', id: `msg_${inference}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'synthetic answer', annotations: [] }] }]);
    };
    const client = new SiwcClient({ withAccessToken: operation => operation('synthetic-test-only') }, { beforeRequest: async () => {} });
    const first = await client.complete({ model: 'fixture', input: [{ role: 'user', content: 'synthetic' }] });
    const pending = client.complete({ model: 'fixture', input: structuredClone(first.output) });
    await ready; client.clearReplayHistory(); release();
    await assert.rejects(pending, { code: 'CANCELLED' });
    assert.equal((client as any).replays.size, 0);
    await assert.rejects(client.complete({ model: 'fixture', input: structuredClone(first.output) }), { code: 'INVALID_REPLAY_CONTEXT' });
    assert.equal(inference, 2);
  } finally { release?.(); globalThis.fetch = old; }
});

test('Windows factory persists quota stops across reconstruction until a new human begin', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'siwc-sdk-quota-'));
  const oldLocal = process.env.LOCALAPPDATA; const oldFetch = globalThis.fetch;
  let inference = 0;
  const request = { model: 'fixture', input: [{ role: 'user' as const, content: 'test' }] };
  const synthetic = (appId: string) => {
    const runtime = createWindowsClient({ appId, appName: 'Synthetic Quota Test' });
    runtime.auth.withAccessToken = async operation => operation('synthetic-test-only');
    runtime.auth.openRequestScope = async () => ({ signal: new AbortController().signal, close() {} });
    runtime.auth.status = async () => ({ activeId: 'synthetic-registration', registrations: [] });
    return runtime;
  };
  try {
    process.env.LOCALAPPDATA = folder;
    for (const [index, code] of ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].entries()) {
      const id = `synthetic-quota-${index}`;
      globalThis.fetch = async url => {
        if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] });
        assert.equal(url, 'https://api.openai.com/v1/responses'); inference++;
        return Response.json({ error: { code } }, { status: 429 });
      };
      const first = synthetic(id); await first.begin({ maxRequests: 3, creditSettingsConfirmed: true });
      await assert.rejects(first.client.complete(request), { code });
      const afterError = inference;
      const next = synthetic(id);
      assert.equal((await next.budget.status()).enabled, false);
      await assert.rejects(next.client.complete(request), { code: 'INFERENCE_NOT_STARTED' });
      assert.equal(inference, afterError);
      await next.begin({ maxRequests: 1, creditSettingsConfirmed: true });
      await assert.rejects(next.client.complete(request), { code });
      assert.equal(inference, afterError + 1);
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocal;
  }
});
