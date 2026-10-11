/** Offline security regression checks. Usage: node audit-response-guards.mjs <trusted-built-sdk-lib-directory>
 * Imports only http.js/protocol.js. No AuthManager, real credential, file write, or live HTTP is used.
 */
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
if (process.argv.length !== 3) { console.error('Usage: node audit-response-guards.mjs <trusted-built-sdk-lib-directory>'); process.exit(2); }
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Live HTTP is prohibited in this test'); };
const results = [];
try {
  const directory = resolve(process.argv[2]);
  const { readText, MAX_JSON_BYTES } = await import(pathToFileURL(join(directory, 'http.js')).href);
  const { ResponseStream, readSse } = await import(pathToFileURL(join(directory, 'protocol.js')).href);
  async function test(name, operation) { await operation(); results.push({ test: name, result: 'PASS' }); }
  function streaming(chunks, headers = {}) {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); }, cancel() { cancelled = true; } });
    return { response: new Response(body, { headers }), wasCancelled: () => cancelled };
  }
  await test('exact_1_MiB_is_accepted', async () => {
    const text = 'x'.repeat(MAX_JSON_BYTES); assert.equal(await readText(new Response(text)), text);
  });
  await test('chunked_1_MiB_plus_1_is_rejected_and_cancelled', async () => {
    const fixture = streaming([new Uint8Array(MAX_JSON_BYTES / 2), new Uint8Array(MAX_JSON_BYTES / 2 + 1)]);
    await assert.rejects(readText(fixture.response), { code: 'RESPONSE_TOO_LARGE' }); assert.equal(fixture.wasCancelled(), true);
  });
  await test('oversized_content_length_is_rejected_and_cancelled', async () => {
    const fixture = streaming([new Uint8Array([65])], { 'content-length': String(MAX_JSON_BYTES + 1) });
    await assert.rejects(readText(fixture.response), { code: 'RESPONSE_TOO_LARGE' }); assert.equal(fixture.wasCancelled(), true);
  });
  await test('UTF8_limit_is_bytes_not_characters', async () => {
    const encoded = new TextEncoder().encode('あ'.repeat(Math.floor(MAX_JSON_BYTES / 3) + 1));
    const fixture = streaming([encoded]);
    await assert.rejects(readText(fixture.response), { code: 'RESPONSE_TOO_LARGE' }); assert.equal(fixture.wasCancelled(), true);
  });
  await test('invalid_UTF8_is_rejected', async () => {
    await assert.rejects(readText(new Response(new Uint8Array([0xc3, 0x28]))), { name: 'TypeError' });
  });
  await test('abort_cancels_pending_body_read', async () => {
    const controller = new AbortController(); const fixture = streaming([]);
    const pending = readText(fixture.response, controller.signal); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(fixture.wasCancelled(), true);
  });
  const call = { type: 'function_call', id: 'fixture_call_item', call_id: 'fixture_call_id',
    namespace: 'local', name: 'read_dummy', arguments: '{"path":"fixture.txt"}', status: 'completed' };
  const completed = output => ({ type: 'response.completed', response: { status: 'completed', output } });
  const stream = () => new ResponseStream('fixture_model', new Set(['local/read_dummy']));
  await test('allowed_completed_tool_call_is_accepted', async () => {
    const events = stream().accept(completed([call])); assert.ok(events.some(event => event.type === 'completed'));
  });
  await test('unrequested_tool_name_is_rejected', async () => {
    assert.throws(() => stream().accept(completed([{ ...call, name: 'not_authorized' }])), { code: 'INVALID_TOOL_CALL' });
  });
  await test('unrequested_namespace_is_rejected', async () => {
    assert.throws(() => stream().accept(completed([{ ...call, namespace: 'not_authorized' }])), { code: 'INVALID_TOOL_CALL' });
  });
  await test('malformed_tool_arguments_are_rejected', async () => {
    assert.throws(() => stream().accept(completed([{ ...call, arguments: '{' }])), { code: 'INVALID_TOOL_ARGUMENTS' });
  });
  await test('non_object_tool_arguments_are_rejected', async () => {
    assert.throws(() => stream().accept(completed([{ ...call, arguments: '[]' }])), { code: 'INVALID_TOOL_ARGUMENTS' });
  });
  await test('duplicate_tool_call_ids_are_rejected', async () => {
    assert.throws(() => stream().accept(completed([call, { ...call, id: 'fixture_second_item' }])), { code: 'INVALID_TOOL_CALL' });
  });
  await test('incomplete_response_is_rejected', async () => {
    assert.throws(() => stream().accept({ type: 'response.incomplete' }), { code: 'RESPONSE_INCOMPLETE' });
  });
  await test('unfinished_SSE_frame_is_rejected', async () => {
    await assert.rejects(async () => { for await (const _ of readSse(new Response('data: {"type":"response.created"}').body)) {} }, { code: 'STREAM_INTERRUPTED' });
  });
  console.log(JSON.stringify({ testedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    realNetworkRequests: 0, realCredentialsUsed: false, testCount: results.length, passed: results.length, results }, null, 2));
} finally { globalThis.fetch = originalFetch; }
