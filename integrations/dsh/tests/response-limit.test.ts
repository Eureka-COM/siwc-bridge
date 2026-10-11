import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { SiwcAdapter, SiwcLlmError } from '../lib/adapter.js';
import { BridgeError, safeFailure } from '../lib/errors.js';

const LIMIT = 1024 * 1024;
function oversized(status: number, declared = false) {
  let produced = 0, cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= 3 * LIMIT) { controller.close(); return; }
      const chunk = new Uint8Array(64 * 1024).fill(32); produced += chunk.byteLength; controller.enqueue(chunk);
    },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { status, headers: declared ? { 'content-length': String(3 * LIMIT) } : {} }),
    stats: () => ({ produced, cancelled, locked: body.locked }) };
}
test('error and model JSON are bounded during reading, including bodies without Content-Length', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [400, 200]) for (const declared of [false, true]) {
      const fixture = oversized(status, declared);
      globalThis.fetch = async () => fixture.response;
      const client = new SiwcAdapter({ withAccessToken: operation => operation('synthetic-test-only') });
      await assert.rejects(client.listModels('siwc'), e => (e as any).providerCode === 'RESPONSE_TOO_LARGE');
      assert.ok(fixture.stats().produced <= LIMIT + 64 * 1024);
      if (declared) assert.equal(fixture.stats().produced, 0);
      assert.equal(fixture.stats().cancelled, 1);
      assert.equal(fixture.stats().locked, false);
    }
  } finally { globalThis.fetch = original; }
});
test('explicit catalog refresh preserves oversized diagnostics without sending inference or leaking the body', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [200, 400]) for (const declared of [false, true]) {
      const fixture = oversized(status, declared); fixture.response.headers.set('x-request-id', 'req_fixture');
      let inference = 0;
      globalThis.fetch = async url => {
        if (url === 'https://api.openai.com/v1/responses') inference++;
        assert.equal(url, 'https://api.openai.com/v1/models'); return fixture.response;
      };
      const client = new SiwcAdapter({ withAccessToken: operation => operation('synthetic-test-only') });
      await assert.rejects(client.listModelsFresh('siwc'), (error: any) => {
        assert.equal(error.code, 'RESPONSE_TOO_LARGE'); assert.equal(error.providerCode, 'RESPONSE_TOO_LARGE');
        assert.equal(error.failure.status, status); assert.equal(error.failure.requestId, 'req_fixture');
        assert.match(safeFailure(error), /provider_code=RESPONSE_TOO_LARGE/); return true;
      });
      assert.equal(inference, 0); assert.ok(fixture.stats().produced <= LIMIT + 64 * 1024);
      if (declared) assert.equal(fixture.stats().produced, 0);
      assert.equal(fixture.stats().cancelled, 1); assert.equal(fixture.stats().locked, false);
    }
  } finally { globalThis.fetch = original; }
});

test('explicit catalog refresh preserves safe classifications and diagnostics across both error handlers', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, routing, native] of [[401, 'AUTH', 'fixture_error'], [403, 'FORBIDDEN', 'fixture_error'], [429, 'RATE_LIMIT', 'fixture_error'], [503, 'SERVER', 'fixture_error'],
      [429, 'QUOTA', 'subscription_sharing_usage_limit_exceeded'], [429, 'QUOTA', 'subscription_sharing_usage_unavailable']] as const) {
      globalThis.fetch = async url => {
        assert.equal(url, 'https://api.openai.com/v1/models');
        return Response.json({ error: { code: native, param: 'workspace', message: 'FAKE_SECRET_ECHO' } }, { status, headers: { 'x-request-id': 'req_fixture' } });
      };
      const client = new SiwcAdapter({ withAccessToken: operation => operation('synthetic-test-only') });
      await assert.rejects(client.listModelsFresh('siwc'), (error: any) => {
        assert.equal(error.code, routing); assert.equal(error.providerCode, native);
        assert.equal(error.failure.status, status); assert.equal(error.failure.requestId, 'req_fixture');
        assert.equal(error.param, 'workspace'); assert.equal(error.responseShape, 'structured_error');
        assert.equal(JSON.stringify(error.failure).includes('FAKE_SECRET_ECHO'), false);
        assert.equal(safeFailure(error).includes('FAKE_SECRET_ECHO'), false); return true;
      });
      if (routing === 'QUOTA') assert.equal(client.isUsageLimited(), true);
    }
  } finally { globalThis.fetch = original; }
});

test('caller cancellation and timeout take priority over an already classified credential error', async () => {
  for (const [reason, expected] of [[new DOMException('fixture', 'AbortError'), 'ABORTED'], [new DOMException('fixture', 'TimeoutError'), 'TIMEOUT']] as const) {
    const controller = new AbortController();
    const client = new SiwcAdapter({ withAccessToken: async () => { controller.abort(reason); throw new SiwcLlmError(new BridgeError('RESPONSE_TOO_LARGE', 'fixture'), 'RESPONSE_TOO_LARGE'); } });
    await assert.rejects(async () => { for await (const _ of client.stream({ provider: 'siwc', model: 'fixture', messages: [], signal: controller.signal })) {} }, { code: expected });
  }
});

test('external unprocessed errors remain sanitized transport errors', async () => {
  for (const external of [new Error('FAKE_SECRET_ECHO'), new LlmError('FAKE_SECRET_ECHO', 'AUTH')]) {
    const client = new SiwcAdapter({ withAccessToken: async () => { throw external; } });
    await assert.rejects(async () => { for await (const _ of client.stream({ provider: 'siwc', model: 'fixture', messages: [] })) {} }, (error: any) => {
      assert.equal(error.code, 'TRANSPORT'); assert.equal(error.providerCode, 'TRANSPORT');
      assert.equal(JSON.stringify(error.failure).includes('FAKE_SECRET_ECHO'), false);
      assert.equal(safeFailure(error).includes('FAKE_SECRET_ECHO'), false); return true;
    });
  }
});

test('blocked JSON read is cancelled and unlocked when the caller aborts', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let entered!: () => void, cancelled = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({ start(c) { streamController = c; }, pull() { entered(); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  try {
    globalThis.fetch = async () => new Response(body);
    const client = new SiwcAdapter({ withAccessToken: operation => operation('synthetic-test-only') });
    const pending = client.listModels('siwc', controller.signal);
    await waiting; controller.abort();
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('JSON read ignored abort')), 1000); })]), e => (e as any).providerCode === 'CANCELLED' || (e as any).code === 'ABORTED');
    assert.equal(cancelled, 1); assert.equal(body.locked, false);
  } finally { clearTimeout(timer); try { streamController.error(new Error('fixture cleanup')); } catch {} globalThis.fetch = original; }
});
