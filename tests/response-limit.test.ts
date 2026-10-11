import test from 'node:test';
import assert from 'node:assert/strict';
import { SiwcClient } from '../lib/client.js';

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
      const client = new SiwcClient({ withAccessToken: operation => operation('synthetic-test-only') }, { beforeRequest: async () => undefined });
      await assert.rejects(client.listModels(), e => (e as any).code === 'RESPONSE_TOO_LARGE');
      assert.ok(fixture.stats().produced <= LIMIT + 64 * 1024);
      if (declared) assert.equal(fixture.stats().produced, 0);
      assert.equal(fixture.stats().cancelled, 1);
      assert.equal(fixture.stats().locked, false);
    }
  } finally { globalThis.fetch = original; }
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
    const client = new SiwcClient({ withAccessToken: operation => operation('synthetic-test-only') }, { beforeRequest: async () => undefined });
    const pending = client.listModels(controller.signal);
    await waiting; controller.abort();
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('JSON read ignored abort')), 1000); })]), e => (e as any).code === 'CANCELLED' || (e as any).code === 'ABORTED');
    assert.equal(cancelled, 1); assert.equal(body.locked, false);
  } finally { clearTimeout(timer); try { streamController.error(new Error('fixture cleanup')); } catch {} globalThis.fetch = original; }
});
