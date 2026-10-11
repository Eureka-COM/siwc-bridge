import test from 'node:test';
import assert from 'node:assert/strict';
import { SiwcAdapter } from '../lib/adapter.js';
import { safeFailure } from '../lib/errors.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testLedger } from '../lib/ledger.js';
import { createAuthTestHarness } from '../lib/auth.js';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';

test('persisted DSH native history is registration-bound across adapter restarts and model changes', async () => {
  const original = globalThis.fetch;
  let activeId = 'registration-a', requests = 0;
  let sent: any;
  const model = 'fixture-replay';
  const credentials = { status: async () => ({ activeId }), withAccessToken: async (operation: any) => operation('synthetic-test-only', undefined, activeId) };
  const create = () => new SiwcAdapter(credentials);
  const base: GenerateOptions = { provider: 'siwc', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] };
  const collect = async (adapter: SiwcAdapter, options: GenerateOptions) => {
    const assembler = new BlockAssembler(); for await (const chunk of adapter.stream(options)) assembler.push(chunk); return assembler;
  };
  try {
    globalThis.fetch = async (url, init) => {
      requests++;
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [model, 'other-model'].map(slug => ({ slug, display_name: slug, visibility: 'list' })) });
      sent = JSON.parse(String(init?.body));
      const output = [{ type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-account-a-fixture' },
        { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture answer' }] }];
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    const first = await collect(create(), base);
    const assistant = first.message({ provider: 'siwc', model, replayState: first.replayState });
    base.messages.push(assistant, { role: 'user', content: [{ type: 'text', text: 'continue' }] });
    await collect(create(), base); // Same persisted registration, reconstructed adapter.
    assert.ok(sent.input.some((item: any) => item.encrypted_content === 'opaque-account-a-fixture'));
    for (const targetModel of [model, 'other-model']) {
      activeId = 'registration-b'; const count = requests;
      await assert.rejects(collect(create(), { ...base, model: targetModel }), (e: any) => e.providerCode === 'INVALID_REPLAY_CONTEXT');
      assert.equal(requests, count);
    }
    activeId = 'registration-a';
    const legacy = structuredClone(base); delete (legacy.messages[1] as any).source.replayState.response.registrationId;
    const count = requests;
    await assert.rejects(collect(create(), legacy), (e: any) => e.providerCode === 'INVALID_REPLAY_CONTEXT'); assert.equal(requests, count);
    await collect(create(), { ...base, model: 'other-model' }); // Same-account model switch remains valid.
    assert.equal(sent.input.some((item: any) => item.type === 'reasoning'), false);
    activeId = 'registration-b'; await collect(create(), { ...base, messages: [base.messages[0]] }); // New conversation is allowed.
  } finally { globalThis.fetch = original; }
});

test('registration bound to the acquired token is checked before inference, even if status is stale', async () => {
  const original = globalThis.fetch; let inference = 0;
  try {
    globalThis.fetch = async url => {
      if (url === 'https://api.openai.com/v1/responses') inference++;
      return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] });
    };
    const adapter = new SiwcAdapter({ status: async () => ({ activeId: 'registration-a' }), withAccessToken: async operation => operation('synthetic-test-only', undefined, 'registration-b') });
    await assert.rejects(async () => { for await (const _ of adapter.stream({ provider: 'siwc', model: 'fixture', messages: [] })) {} }, (e: any) => e.providerCode === 'INVALID_REPLAY_CONTEXT');
    assert.equal(inference, 0);
  } finally { globalThis.fetch = original; }
});

test('registration change before completed response releases no terminal tool or replay state', async () => {
  const original = globalThis.fetch; let activeId = 'registration-a'; const chunks: any[] = [];
  try {
    globalThis.fetch = async url => {
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] });
      const output = [{ type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', namespace: 'dsh', name: 'read_dummy', arguments: '{}', status: 'completed' }];
      let sent = false;
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        if (sent) { controller.close(); return; } sent = true; activeId = 'registration-b';
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`));
      } }, { highWaterMark: 0 });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const adapter = new SiwcAdapter({ status: async () => ({ activeId }), withAccessToken: async operation => operation('synthetic-test-only', undefined, activeId) });
    await assert.rejects(async () => { for await (const chunk of adapter.stream({ provider: 'siwc', model: 'fixture', messages: [], tools: [{ name: 'read_dummy', parameters: {} }] })) chunks.push(chunk); }, (e: any) => e.providerCode === 'INVALID_REPLAY_CONTEXT');
    assert.deepEqual(chunks, []);
  } finally { globalThis.fetch = original; }
});

test('an unregistered credential source cannot replay opaque history after switching its token', async () => {
  const original = globalThis.fetch; let currentToken = 'synthetic-account-a', requests = 0;
  try {
    globalThis.fetch = async url => {
      requests++;
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] });
      const output = [{ type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-account-a-fixture' },
        { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture answer' }] }];
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    };
    const adapter = new SiwcAdapter({ withAccessToken: async operation => operation(currentToken) });
    const options: GenerateOptions = { provider: 'siwc', model: 'fixture', messages: [] };
    const assembler = new BlockAssembler(); for await (const chunk of adapter.stream(options)) assembler.push(chunk);
    options.messages.push(assembler.message({ provider: 'siwc', model: 'fixture', replayState: assembler.replayState }));
    currentToken = 'synthetic-account-b'; const before = requests;
    await assert.rejects(async () => { for await (const _ of adapter.stream(options)) {} }, (e: any) => e.providerCode === 'INVALID_REPLAY_CONTEXT');
    assert.equal(requests, before);
  } finally { globalThis.fetch = original; }
});

test('caller cancellation settles registration lookup while another credential transaction holds the lock', async () => {
  const now = Date.now(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { entered = resolve; });
  const auth = createAuthTestHarness({ seed: { version: 1, hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', activeId: 'fixture', registrations: [{
    id: 'fixture', label: 'Fixture', clientId: 'oaiapp_fixture', subject: 'fixture-subject', issuer: 'https://auth.openai.com', planConfirmed: true,
    credentials: { accessToken: 'fake-access-never-real', scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: now + 3600000, savedAt: new Date(now).toISOString() },
  }] }, now: () => now, openBrowser: async () => {}, transport: async () => { throw new Error('No HTTP expected'); } });
  const holder = auth.withAccessToken(async () => { entered(); await gate; }); await held;
  const adapter = new SiwcAdapter(auth), abort = new AbortController();
  const pending = (async () => { for await (const _ of adapter.stream({ provider: 'siwc', model: 'fixture', messages: [], signal: abort.signal })) {} })();
  const settled = pending.then(() => 'COMPLETED', (e: any) => e.code);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise(resolve => setTimeout(resolve, 10)); abort.abort();
    assert.equal(await Promise.race([settled, new Promise(resolve => { timer = setTimeout(() => resolve('STILL_WAITING'), 150); })]), 'ABORTED');
  } finally { clearTimeout(timer); release(); await holder; await settled; }
});

test('usage limit/unavailable stops the shared ledger across adapter restarts', async () => {
  const original = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'siwc-dsh-quota-'));
  let inference = 0;
  const options = { provider: 'siwc', model: 'fixture', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'fixture' }] }] };
  const collect = async (adapter: SiwcAdapter) => { for await (const _ of adapter.stream(options)) {} };
  try {
    for (const [index, code] of ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].entries()) {
      const ledger = testLedger(join(directory, `${index}.json`)); await ledger.arm(); await ledger.finish();
      const create = () => new SiwcAdapter({ withAccessToken: operation => operation('synthetic-test-only') }, {
        beforeRequest: (kind, signal) => ledger.request(kind, signal), onUsageLimit: () => ledger.stop(),
      });
      globalThis.fetch = async url => {
        if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture', display_name: 'Fixture', visibility: 'list' }] });
        assert.equal(url, 'https://api.openai.com/v1/responses'); inference++;
        return Response.json({ error: { code } }, { status: 429 });
      };
      await assert.rejects(collect(create()), { code: 'QUOTA' });
      const count = inference;
      assert.equal((await ledger.status()).armed, false); assert.equal((await ledger.status()).personalUse, false);
      await assert.rejects(collect(create()), { code: 'LIVE_NOT_STARTED' }); assert.equal(inference, count);
      await assert.rejects(ledger.finish(), { code: 'LIVE_NOT_STARTED' });
      await ledger.arm(); await assert.rejects(collect(create()), { code: 'QUOTA' }); assert.equal(inference, count + 1);
    }
  } finally { globalThis.fetch = original; }
});

test('dshのserialized failureとコマンド診断にsafeなnative code/param/request IDを残す', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 403, 429, 503]) {
      globalThis.fetch = async url => {
        assert.equal(url, 'https://api.openai.com/v1/models');
        return new Response(JSON.stringify({ error: { code: 'subscription_sharing_user_not_eligible', param: 'workspace', message: 'FAKE_SECRET_ECHO' } }),
          { status, headers: { 'x-request-id': 'req_fixture' } });
      };
      const adapter = new SiwcAdapter({ withAccessToken: operation => operation('synthetic-test-only') });
      await assert.rejects(adapter.listModels('siwc'), (error: any) => {
        const saved = JSON.parse(JSON.stringify(error.failure));
        assert.equal(saved.status, status); assert.equal(saved.requestId, 'req_fixture');
        assert.match(saved.message, /provider_code=subscription_sharing_user_not_eligible/);
        assert.match(saved.message, /param=workspace/); assert.match(saved.message, /shape=structured_error/);
        assert.match(safeFailure(error), /req_fixture/);
        assert.equal(saved.message.includes('FAKE_SECRET_ECHO'), false);
        assert.equal(safeFailure(error).includes('FAKE_SECRET_ECHO'), false);
        return true;
      });
    }
  } finally { globalThis.fetch = original; }
});

test('HTTP headers後にauth scopeが中断したstreamはcompleted toolを実行へ渡さない', async () => {
  const original = globalThis.fetch; const cancelled = new AbortController();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let fetched!: () => void; const headersReceived = new Promise<void>(resolve => { fetched = resolve; });
  let releasedScopes = 0; let tools = 0; let streamCancelled = 0;
  try {
    globalThis.fetch = async url => {
      if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = new ReadableStream<Uint8Array>({ start(c) { streamController = c; }, cancel() { streamCancelled++; } });
      fetched(); return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const adapter = new SiwcAdapter({
      withAccessToken: operation => operation('synthetic-test-only'),
      openRequestScope: async () => ({ signal: cancelled.signal, close() { releasedScopes++; } }),
    });
    const pending = (async () => {
      for await (const chunk of adapter.stream({ provider: 'siwc', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }], tools: [] })) {
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') tools++;
      }
    })();
    await headersReceived; cancelled.abort();
    await assert.rejects(pending, { code: 'ABORTED' });
    // One request scope: inference no longer re-fetches the model catalog first.
    assert.equal(tools, 0); assert.equal(streamCancelled, 1); assert.equal(releasedScopes, 1);
    assert.throws(() => streamController!.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n')));
  } finally { globalThis.fetch = original; }
});
