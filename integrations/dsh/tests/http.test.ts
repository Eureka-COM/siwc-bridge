import test from 'node:test';
import assert from 'node:assert/strict';
import { readText, MAX_JSON_BYTES } from '../lib/http.js';

test('an already aborted JSON read cancels and unlocks its response body without reading', async () => {
  let cancelled = 0, pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readText(new Response(body), controller.signal), { name: 'AbortError' });
  assert.equal(cancelled, 1); assert.equal(pulls, 0); assert.equal(body.locked, false);
});

test('JSON receive limit accepts the exact byte boundary and counts multibyte UTF-8', async () => {
  const exact = '{"ok":true}' + ' '.repeat(MAX_JSON_BYTES - 11);
  assert.deepEqual(JSON.parse(await readText(new Response(exact))), { ok: true });
  const multibyte = '"' + 'あ'.repeat(Math.floor(MAX_JSON_BYTES / 3) + 1) + '"';
  assert.ok(multibyte.length < MAX_JSON_BYTES);
  await assert.rejects(readText(new Response(multibyte)), { code: 'RESPONSE_TOO_LARGE' });
});
test('an oversized body with a valid JSON prefix is rejected, never parsed as the prefix', async () => {
  let cancelled = 0, pull = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (pull++ === 0) controller.enqueue(new TextEncoder().encode('{"ok":true}'));
    else controller.enqueue(new Uint8Array(MAX_JSON_BYTES).fill(32));
  }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  await assert.rejects(readText(new Response(body)), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, 1); assert.equal(pull, 2); assert.equal(body.locked, false);
});
