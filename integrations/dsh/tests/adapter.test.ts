import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler, IMAGE_OFFLOAD_REQUIRED_CODE, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SiwcAdapter, IMAGE_POLICY, requestImageSize } from '../lib/adapter.js';
import { safeFailure } from '../lib/errors.js';
import type { Diagnostics } from '../lib/diagnostics.js';

const model = 'gpt-6.1-sol';
const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
const options = (extra: Partial<GenerateOptions> = {}): GenerateOptions => ({ provider: 'siwc', model, messages: [user('secret prompt text')], ...extra });
const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_ok' } });
const answer = (text = 'ok') => sse({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
  { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] } });
function credentials(registration = { value: 'reg-a' }) {
  return { status: async () => ({ activeId: registration.value, registrations: [{ id: registration.value, authenticated: true, planAllowed: true, planConfirmed: true }] }),
    withAccessToken: async (operation: any) => operation('synthetic-test-only', undefined, registration.value) };
}
function memoryDiagnostics(): Diagnostics & { lines: string[] } {
  const lines: string[] = [];
  return { lines, location: 'memory', record(fields) { lines.push(Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ')); }, async tail() { return lines; } };
}
async function run(adapter: SiwcAdapter, request: GenerateOptions): Promise<StreamChunk[]> { const chunks: StreamChunk[] = []; for await (const chunk of adapter.stream(request)) chunks.push(chunk); return chunks; }
function mockFetch(t: test.TestContext, handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; body?: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => { calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined }); return handler(url, init); });
  return calls;
}

test('a turn streams through, with the token’s own registration in its replay state and a label-only diagnostics line', async t => {
  const calls = mockFetch(t, () => answer('hello'));
  const diagnostics = memoryDiagnostics();
  const chunks = await run(new SiwcAdapter(credentials(), { diagnostics }), options({ reasoningEffort: ReasoningEffortId('high') }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.store, false); assert.deepEqual(calls[0]!.body.reasoning, { effort: 'high', summary: 'auto' });
  const finish = chunks.at(-1) as any;
  assert.equal(finish.reason.kind, 'stop'); assert.equal(finish.replayState.response.registrationId, 'reg-a');
  assert.equal(diagnostics.lines.length, 1);
  assert.match(diagnostics.lines[0]!, /kind=inference model=gpt-6.1-sol outcome=ok http=200 request_id=req_ok/);
  assert.equal(diagnostics.lines[0]!.includes('secret prompt text'), false);
});

test('history is built for the registration of the token actually used, so another account’s reasoning is never sent', async t => {
  const registration = { value: 'reg-a' };
  const calls = mockFetch(t, () => sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'first' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-a' },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'first' }] }] } }));
  const adapter = new SiwcAdapter(credentials(registration));
  const assembler = new BlockAssembler(); let state;
  for (const chunk of await run(adapter, options())) { assembler.push(chunk); if (chunk.type === 'finish') state = chunk.replayState; }
  const history = options({ messages: [user('q'), assembler.message({ provider: 'siwc', model, replayState: state }), user('next')] });
  await run(adapter, history);
  assert.ok(calls[1]!.body.input.some((item: any) => item.encrypted_content === 'opaque-a'));
  registration.value = 'reg-b';
  await run(adapter, history);
  assert.equal(calls[2]!.body.input.some((item: any) => item.type === 'reasoning'), false);
  assert.ok(calls[2]!.body.input.some((item: any) => item.role === 'assistant' && item.content === 'first'));
});

test('usage limit pauses new requests without sending them until /siwc resume; other service errors stay retryable', async t => {
  let mode = 'limit';
  const calls = mockFetch(t, () => mode === 'limit'
    ? Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'SECRET_ECHO' } }, { status: 429, headers: { 'x-request-id': 'req_limit' } })
    : mode === 'unavailable' ? Response.json({ error: { code: 'subscription_sharing_usage_unavailable' } }, { status: 503 }) : answer());
  const adapter = new SiwcAdapter(credentials());
  await assert.rejects(run(adapter, options()), (error: any) => {
    assert.equal(error.code, 'QUOTA'); assert.match(error.message, /Manage usage/); assert.match(error.message, /request_id=req_limit/);
    assert.equal(safeFailure(error).includes('SECRET_ECHO'), false); return true;
  });
  assert.equal(adapter.isPaused(), true);
  await assert.rejects(run(adapter, options()), (error: any) => error.code === 'QUOTA' && /\/siwc resume/.test(error.message));
  assert.equal(calls.length, 1, 'paused requests are not sent');
  adapter.resume(); mode = 'unavailable';
  await assert.rejects(run(adapter, options()), { code: 'SERVER' });
  assert.equal(adapter.isPaused(), false);
  mode = 'ok'; await run(adapter, options());
  assert.equal(calls.length, 3);
  const policy = adapter.providerRetryPolicy('siwc');
  assert.equal(policy.mode, 'normal');
  if (policy.mode === 'normal') { assert.equal(policy.maxRetries, 4); for (const code of ['TRANSPORT', 'SERVER', 'RATE_LIMIT', 'TIMEOUT', 'EMPTY_RESPONSE']) assert.ok(policy.retryableCodes.includes(code), code); assert.equal(policy.retryableCodes.includes('QUOTA'), false); }
});

test('HTTP and transport failures map to DSH routing codes', async t => {
  let response: () => Response | Promise<Response> = () => answer();
  mockFetch(t, () => response());
  const adapter = () => new SiwcAdapter(credentials());
  for (const [status, body, code] of [[401, { error: { code: 'subscription_sharing_invalid_user' } }, 'AUTH'], [403, { error: { code: 'subscription_sharing_user_not_eligible' } }, 'FORBIDDEN'],
    [429, { error: { code: 'rate_limit_exceeded' } }, 'RATE_LIMIT'], [500, {}, 'SERVER'], [400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'tools' } }, 'UNSUPPORTED_OPTION'],
    [400, { error: { code: 'context_length_exceeded' } }, 'CONTEXT_WINDOW_EXCEEDED']] as const) {
    response = () => Response.json(body, { status });
    await assert.rejects(run(adapter(), options()), (error: any) => error.code === code, `${status} → ${code}`);
  }
  response = () => { throw new TypeError('fetch failed'); };
  await assert.rejects(run(adapter(), options()), { code: 'TRANSPORT' });
  response = () => new Response('data: {"type":"response.output_text.delta","output_index":0,"delta":"partial"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(run(adapter(), options()), { code: 'TRANSPORT' });
});

test('a stalled stream is abandoned as a retryable TIMEOUT; caller cancellation is ABORTED', async t => {
  mockFetch(t, () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(run(new SiwcAdapter(credentials(), { idleTimeoutMs: 50 }), options()), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const pending = run(new SiwcAdapter(credentials()), options({ signal: controller.signal }));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { code: 'ABORTED' });
});

test('catalog: unshowable entries are skipped, the rest stays usable; models outside the catalog are still allowed', async t => {
  mockFetch(t, url => { assert.equal(url, 'https://api.openai.com/v1/models'); return Response.json({ models: [{ slug: model, display_name: 'GPT-6.1 Sol', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { bad: true }, { slug: 'no-name', visibility: 'list' }] }); });
  const adapter = new SiwcAdapter(credentials());
  const models = await adapter.listModels('siwc');
  assert.deepEqual(models.map(entry => [entry.id, entry.name]), [[model, 'GPT-6.1 Sol'], ['no-name', 'no-name']]);
  assert.deepEqual(models[0]!.inputModalities, ['text', 'image']);
  const known = await adapter.resolveModel('siwc', model);
  assert.equal(known.context?.contextWindow, 1_050_000);
  assert.deepEqual(known.reasoning?.efforts.map(effort => String(effort.id)), ['low', 'medium', 'high', 'xhigh', 'max']);
  const unknown = await adapter.resolveModel('siwc', 'future-model');
  assert.equal(unknown.id, 'future-model'); assert.equal(unknown.context, undefined); assert.equal(unknown.reasoning, undefined);
});

// ---------- attachments ----------

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ref = (id: string) => ({ attachmentId: id, mediaType: 'image/png', bytes: PNG.byteLength, width: 4000, height: 3000, name: `${id}.png` });
function images(bytes = PNG.byteLength) {
  const reads: unknown[] = [];
  return { reads, service: { async readImageRequest(image: any, target: any) { reads.push(target); return { variantId: 'v', attachment: image, data: PNG, mediaType: 'image/png', bytes, width: target.width, height: target.height, depth: 'uchar', space: 'srgb', hasAlpha: false }; } } };
}

test('images are sent as input_image with DSH’s handle text, within DSH’s pixel and byte budget', async t => {
  const calls = mockFetch(t, () => answer());
  const { reads, service } = images();
  await run(new SiwcAdapter(credentials(), { attachments: () => service as any, imageAccess: () => ({ readonlyPath: '/fixture/a.png' }) }),
    options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image', attachment: ref('img-a') }] }] } as any));
  assert.deepEqual(reads, [{ ...requestImageSize(4000, 3000, IMAGE_POLICY.maxPixels), maxBytes: IMAGE_POLICY.maxBytes }]);
  const content = calls[0]!.body.input.find((item: any) => item.role === 'user').content;
  assert.deepEqual(content.map((part: any) => part.type), ['input_text', 'input_text', 'input_image']);
  assert.equal(content[2].image_url, `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
});

test('an image that cannot be loaded, or a missing attachment service, still sends the turn with a visible note', async t => {
  const calls = mockFetch(t, () => answer());
  const request = options({ messages: [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', attachment: ref('img-x') }] }] } as any);
  await run(new SiwcAdapter(credentials()), request);
  await run(new SiwcAdapter(credentials(), { attachments: () => ({ async readImageRequest() { throw new Error('gone'); } }) as any }), request);
  for (const call of calls) assert.match(JSON.stringify(call.body.input), /could not be loaded/);
});

test('too many image bytes ask DSH to offload old images before anything is sent; tool results can carry images', async t => {
  const calls = mockFetch(t, () => answer());
  const big = images(1_200_000);
  const many = options({ messages: [{ role: 'user', content: Array.from({ length: 16 }, (_, i) => ({ type: 'image', attachment: ref(`img-${i}`) })) }] } as any);
  await assert.rejects(run(new SiwcAdapter(credentials(), { attachments: () => big.service as any }), many), (error: any) => error.code === IMAGE_OFFLOAD_REQUIRED_CODE && error.failure.offloadImages > 0);
  assert.equal(calls.length, 0);
  const { service } = images();
  await run(new SiwcAdapter(credentials(), { attachments: () => service as any }), options({ messages: [user('read the screenshot'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: { provider: 'siwc', model } },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'screenshot' }, { type: 'image', attachment: ref('img-t') }] }] } as any));
  const output = calls[0]!.body.input.find((item: any) => item.type === 'function_call_output').output;
  assert.ok(Array.isArray(output) && output.some((part: any) => part.type === 'input_image'));
});
