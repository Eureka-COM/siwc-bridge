import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readText, MAX_JSON_BYTES } from '../lib/http.js';

test('the DSH integration builds its JSON reader, auth, storage and errors from the SDK sources only', async () => {
  const sync = await readFile(new URL('../integrations/dsh/scripts/sync-core.mjs', import.meta.url), 'utf8');
  assert.match(sync, /const modules = \['app', 'auth', 'errors', 'http', 'store'\];/);
  for (const name of ['errors', 'http', 'store']) {
    assert.equal((await readFile(new URL(`../integrations/dsh/src/${name}.ts`, import.meta.url), 'utf8')).trim().split('\n').pop(), `export * from './core/${name}.js';`);
  }
  const auth = await readFile(new URL('../integrations/dsh/src/auth.ts', import.meta.url), 'utf8');
  assert.match(auth, /export \* from '\.\/core\/auth\.js';/);
  // No second implementation of the token or storage logic remains in the integration.
  assert.doesNotMatch(auth, /grant_type|refresh_token|CryptProtect|transaction\(/);
});

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
