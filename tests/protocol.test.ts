import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, mapUsage, providerFailure, readSse, ResponseStream } from '../lib/protocol.js';
import type { ClientEvent, FunctionCallItem, OutputMessage, ReasoningItem, ResponseOutputItem, ResponseRequest } from '../lib/types.js';

const model = 'fixture-account-model';
const tool = (callId = 'call_1', id = 'fc_1'): FunctionCallItem & { id: string } =>
  ({ type: 'function_call', id, call_id: callId, namespace: 'local', name: 'read_dummy', arguments: '{"path":"dummy.txt"}', status: 'completed' });
const message = (text = 'Done.', id = 'msg_1'): OutputMessage =>
  ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const reasoning: ReasoningItem = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'synthetic-complete-opaque', status: 'completed' };
const options = (): ResponseRequest => ({ model, input: [{ role: 'user', content: 'Read the dummy file.' }],
  tools: [{ type: 'namespace', name: 'local', tools: [{ type: 'function', name: 'read_dummy', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] }] });
const added = (item: ResponseOutputItem, index = 0) => ({ type: 'response.output_item.added', output_index: index,
  item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : {}) } });
const done = (item: ResponseOutputItem, index = 0) => ({ type: 'response.output_item.done', output_index: index, item });
const completed = (output: readonly ResponseOutputItem[], extra: Record<string, unknown> = {}) =>
  ({ type: 'response.completed', response: { status: 'completed', output, ...extra } });
const encoded = (events: Record<string, unknown>[]) => new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''));
function body(bytes: Uint8Array, split = false): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); else controller.enqueue(bytes);
    controller.close();
  } });
}

test('native request has caller namespaces, fixed stateless fields, and rejects unsupported options/content before HTTP', () => {
  const request = options(); request.instructions = 'Use approved local tools only.';
  request.tools = [...request.tools!, { type: 'namespace', name: 'other', tools: [{ type: 'function', name: 'read_dummy', parameters: {} }] }];
  const original = JSON.stringify(request), wire = buildRequest(request);
  assert.equal(wire.store, false); assert.equal(wire.stream, true); assert.equal(wire.instructions, request.instructions);
  assert.deepEqual((wire.tools as { name: string }[]).map(namespace => namespace.name), ['local', 'other']);
  assert.equal(JSON.stringify(request), original);
  const systemInput = [{ type: 'message' as const, role: 'system' as const, content: 'Caller instructions.' },
    { role: 'system' as const, content: [{ type: 'input_text' as const, text: 'More instructions.' }] }];
  const systemOriginal = JSON.stringify(systemInput);
  assert.deepEqual((buildRequest({ ...options(), input: systemInput }).input as { role: string }[]).map(item => item.role), ['developer', 'developer']);
  assert.equal(JSON.stringify(systemInput), systemOriginal);
  for (const extra of [{ temperature: 0 }, { max_output_tokens: 32 }, { previous_response_id: 'r' }, { store: true }, { stream: false }, { reasoning: {} }])
    assert.throws(() => buildRequest({ ...options(), ...extra } as ResponseRequest), { code: 'UNSUPPORTED_OPTION' });
  for (const input of [[{ role: 'user', content: [{ type: 'input_image', image_url: 'synthetic' }] }], [{ role: 'tool', content: 'x' }], [{ type: 'item_reference', id: 'rs_1' }]])
    assert.throws(() => buildRequest({ ...options(), input } as never), { code: 'UNSUPPORTED_CONTENT' });
  assert.throws(() => buildRequest({ ...options(), tools: [{ ...options().tools![0], tools: [{ type: 'function', name: 'x', parameters: {}, strict: true }] }] }), { code: 'UNSUPPORTED_TOOL' });
});

test('native completed output and opaque reasoning can be reinserted unchanged with corresponding function results', () => {
  const stream = new ResponseStream(model, new Set(['local/read_dummy']));
  const native = [reasoning, tool(), message()];
  const result = stream.accept(completed(native, { model: 'resolved-model-alias' })).find(event => event.type === 'completed');
  assert.equal(result?.type, 'completed'); if (result?.type !== 'completed') throw new Error('Missing completion');
  assert.equal(result.response.model, model);
  assert.deepEqual(result.response.output, native); assert.notEqual(result.response.output[0], reasoning);
  const request: ResponseRequest = { ...options(), input: [...options().input, ...result.response.output,
    { type: 'function_call_output', call_id: 'call_1', output: 'caller-owned dummy result' }] };
  const original = JSON.stringify(request), input = buildRequest(request).input as ResponseOutputItem[];
  assert.equal(input.find(item => item.type === 'reasoning')?.encrypted_content, reasoning.encrypted_content);
  assert.equal(JSON.stringify(request), original);
  for (const invalidInput of [[{ type: 'function_call_output', call_id: 'missing', output: 'x' }], [tool(), tool('call_1', 'fc_2')],
    [tool(), { type: 'function_call_output', call_id: 'call_1', output: 'x' }, { type: 'function_call_output', call_id: 'call_1', output: 'y' }]])
    assert.throws(() => buildRequest({ ...options(), input: invalidInput } as never), { code: 'INVALID_TOOL_HISTORY' });
  assert.throws(() => buildRequest({ ...options(), input: [{ ...tool(), arguments: '[]' }] }), { code: 'INVALID_TOOL_ARGUMENTS' });
});

test('real SSE framing assembles finished items and releases tools only in complete native output', async () => {
  const call = tool(), msg = message('日本語');
  const events = [added(reasoning), done(reasoning), added(call, 1),
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: call.id, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: call.id, delta: '"dummy.txt"}' },
    { type: 'response.function_call_arguments.done', output_index: 1, item_id: call.id, arguments: call.arguments },
    done(call, 1), added(msg, 2), { type: 'response.output_text.delta', output_index: 2, content_index: 0, item_id: msg.id, delta: '日本語' },
    done(msg, 2), completed([])];
  const stream = new ResponseStream(model, new Set(['local/read_dummy'])); let result: ClientEvent | undefined, calls = 0;
  for await (const event of readSse(body(encoded(events), true))) {
    const chunks = stream.accept(event);
    if (event.type !== 'response.completed') assert.equal(chunks.filter(chunk => chunk.type === 'completed').length, 0);
    for (const chunk of chunks) if (chunk.type === 'completed') { result = chunk; calls += chunk.response.output.filter(item => item.type === 'function_call').length; }
  }
  stream.end(); assert.equal(calls, 1); assert.equal(result?.type, 'completed');
  if (result?.type === 'completed') assert.deepEqual(result.response.output, [reasoning, call, msg]);
});

test('text is live but terminal output must match every streamed text and completed native item', () => {
  const first = message('terminal first', 'msg_first'), second = message('streamed second', 'msg_second');
  const stream = new ResponseStream(model); stream.accept(added(second, 1));
  assert.deepEqual(stream.accept({ type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: second.id, delta: 'streamed second' }),
    [{ type: 'text.delta', text: 'streamed second' }]);
  stream.accept(done(second, 1)); const finish = stream.accept(completed([first, second]));
  assert.deepEqual(finish[0], { type: 'text.delta', text: 'terminal first' });
  assert.equal(finish[1].type, 'completed'); stream.end();
  const bad = new ResponseStream(model); const msg = message('hello'); bad.accept(added(msg));
  bad.accept({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: msg.id, delta: 'partial' }); bad.accept(done(msg));
  assert.throws(() => bad.accept(completed([msg])), { code: 'INVALID_STREAM' }); assert.equal(bad.completed, false);
});

test('incomplete, failed, malformed, changed, missing-done and disconnected responses expose zero completed tools', () => {
  const call = tool();
  for (const terminal of [{ type: 'response.failed', response: { error: { code: 'server_error' } } }, { type: 'response.incomplete' },
    completed([call], { error: { code: 'subscription_sharing_usage_limit_exceeded' } }), completed([call], { incomplete_details: { reason: 'max_output_tokens' } }),
    completed([{ ...call, arguments: '{broken' }]), completed([call, { ...call, id: 'fc_2' }])]) {
    const stream = new ResponseStream(model, new Set(['local/read_dummy'])); stream.accept(added(call)); stream.accept(done(call));
    assert.throws(() => stream.accept(terminal)); assert.equal(stream.completed, false);
  }
  for (const setup of [(stream: ResponseStream) => stream.accept(added(call)), (stream: ResponseStream) => { stream.accept(added(call, 1)); stream.accept(done(call, 1)); }]) {
    const stream = new ResponseStream(model, new Set(['local/read_dummy'])); setup(stream);
    assert.throws(() => stream.accept(completed([])), { code: 'INVALID_STREAM' }); assert.equal(stream.completed, false);
  }
  for (const invalidCall of [{ ...call, namespace: 'undeclared' }, { ...call, arguments: '[]' }, { ...call, async: true }]) {
    const stream = new ResponseStream(model, new Set(['local/read_dummy']));
    assert.throws(() => stream.accept(completed([invalidCall]))); assert.equal(stream.completed, false);
  }
  const disconnected = new ResponseStream(model, new Set(['local/read_dummy'])); disconnected.accept(added(call)); disconnected.accept(done(call));
  assert.throws(() => disconnected.end(), { code: 'STREAM_INTERRUPTED' });
  const changedReasoning = new ResponseStream(model); changedReasoning.accept(added(reasoning)); changedReasoning.accept(done(reasoning));
  assert.throws(() => changedReasoning.accept(completed([{ ...reasoning, encrypted_content: 'synthetic-changed' }, message()])), { code: 'INVALID_STREAM' });
});

test('SSE rejects invalid UTF-8, JSON, event names and unfinished frames; DONE never means completed', async () => {
  for (const bytes of [new TextEncoder().encode('data: {broken}\n\n'), new TextEncoder().encode('event: response.failed\ndata: {"type":"response.completed"}\n\n'),
    new TextEncoder().encode('data: {"type":"response.in_progress"}'), Uint8Array.of(0xc3, 0x28)])
    await assert.rejects(async () => { for await (const _ of readSse(body(bytes))) {} });
  const stream = new ResponseStream(model); for await (const event of readSse(body(new TextEncoder().encode(': heartbeat\n\ndata: [DONE]\n\n')))) stream.accept(event);
  assert.throws(() => stream.end(), { code: 'STREAM_INTERRUPTED' });
  const ordered = new ResponseStream(model); ordered.accept({ type: 'response.in_progress', sequence_number: 8 });
  assert.throws(() => ordered.accept({ type: 'response.in_progress', sequence_number: 8 }), { code: 'INVALID_STREAM' });
});

test('cancelled blocked SSE reads cancel and release resources without a completion event', async () => {
  const cancellation = new AbortController(); let cancels = 0;
  const responseBody = new ReadableStream<Uint8Array>({ cancel() { cancels++; } });
  const pending = (async () => { for await (const _ of readSse(responseBody, cancellation.signal)) {} })();
  cancellation.abort(); await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(cancels, 1); assert.equal(responseBody.locked, false);
});

test('usage and diagnostics preserve safe machine fields without service text or opaque payload values', () => {
  assert.deepEqual(mapUsage({ input_tokens: 30, output_tokens: 8, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 38 }), { inputTokens: 23, outputTokens: 8, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 3, totalTokens: 38 });
  assert.equal(mapUsage(undefined), undefined); assert.equal(mapUsage({ input_tokens: 2, output_tokens: 1, input_tokens_details: { cached_tokens: 3 } }), undefined);
  const secret = 'SYNTHETIC_PRIVATE_PAYLOAD';
  const error = providerFailure({ error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[0]', message: secret } }, 400, 'req_fixture');
  assert.equal(error.requestId, 'req_fixture'); assert.equal(error.param, 'tools[0]'); assert.equal(error.responseShape, 'structured_error');
  assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(secret), false);
  assert.throws(() => new ResponseStream(model).accept({ type: `response.future?token=${secret}`, encrypted_content: secret }), (failure: any) => {
    assert.equal(failure.code, 'UNSUPPORTED_STREAM_EVENT'); assert.match(failure.message, /event.type=redacted/);
    assert.equal(`${failure.message} ${JSON.stringify(failure)}`.includes(secret), false); return true;
  });
});

test('service notices outside the Responses namespace are skipped without completing a turn', () => {
  const stream = new ResponseStream(model);
  for (const type of ['codex.rate_limits', 'keepalive']) assert.deepEqual(stream.accept({ type, payload: { anything: true } }), []);
  assert.throws(() => stream.end());
  assert.throws(() => new ResponseStream(model).accept({ type: 'notice?token=FAKE_SECRET' }), (error: any) => error.code === 'UNSUPPORTED_STREAM_EVENT' && !error.message.includes('FAKE_SECRET'));
});
