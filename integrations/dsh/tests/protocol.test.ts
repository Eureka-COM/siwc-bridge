import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, mapUsage, providerFailure, readSse, ResponseStream } from '../lib/protocol.js';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

const model = 'fixture-account-model';
const options = (): GenerateOptions => ({ provider: 'siwc', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the dummy file.' }] }],
  tools: [{ name: 'read_dummy', description: 'Read only the test dummy file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] });
const tool = (id = 'call_1', itemId = 'fc_1', args = '{"path":"dummy.txt"}') => ({ type: 'function_call', id: itemId, call_id: id, namespace: 'dsh', name: 'read_dummy', arguments: args, status: 'completed' });
const message = (text = 'The file says hello.') => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const added = (item: Record<string, unknown>, index = 0) => ({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : {}) } });
const done = (item: Record<string, unknown>, index = 0) => ({ type: 'response.output_item.done', output_index: index, item });
const completed = (output: unknown[], usage?: unknown) => ({ type: 'response.completed', response: { status: 'completed', output, ...(usage ? { usage } : {}) } });

test('request uses namespace and explicit full history; unsupported options/content stop before transport', () => {
  const o = options(); o.system = 'Protect local files.';
  const wire = buildRequest(o);
  assert.equal(wire.store, false); assert.equal(wire.stream, true);
  assert.deepEqual((wire.input as unknown[])[0], { role: 'developer', content: o.system });
  assert.deepEqual((wire.tools as Record<string, unknown>[])[0].type, 'namespace');
  assert.equal((wire.tools as Record<string, unknown>[])[0].name, 'dsh');
  for (const extra of [{ temperature: 0 }, { maxTokens: 32 }, { stop: ['x'] }, { top_p: 1 }, { previous_response_id: 'r' }, { reasoningEffort: 'high' }]) {
    assert.throws(() => buildRequest({ ...options(), ...extra } as GenerateOptions), { code: 'UNSUPPORTED_OPTION' });
  }
  assert.throws(() => buildRequest({ ...options(), messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] } as GenerateOptions), { code: 'UNSUPPORTED_CONTENT' });
});

test('completed native calls, fragments and reasoning replay through the real dsh message shape', () => {
  const stream = new ResponseStream(model, new Set(['read_dummy']));
  const a = tool(), b = tool('call_2', 'fc_2', '{"path":"second.txt"}');
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'synthetic-complete-opaque', status: 'completed' };
  assert.deepEqual(stream.accept(added(reasoning, 0)), []);
  stream.accept(done(reasoning, 0));
  assert.deepEqual(stream.accept(added(a, 1)), []);
  assert.deepEqual(stream.accept({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"path":' }), []);
  assert.deepEqual(stream.accept({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '"dummy.txt"}' }), []);
  stream.accept({ type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_1', arguments: a.arguments });
  stream.accept(done(a, 1)); stream.accept(added(b, 2)); stream.accept(done(b, 2));
  const chunks = stream.accept(completed([reasoning, a, b], { input_tokens: 30, output_tokens: 8, input_tokens_details: { cached_tokens: 5 }, total_tokens: 38 }));
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block);
  assert.deepEqual(blocks.map(block => block.type === 'tool-call' && block.id), ['call_1', 'call_2']);
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.argumentsDelta), ['{"path":', '"dummy.txt"}', b.arguments]);
  assert.equal(chunks.at(-2)?.type, 'usage');
  const finish = chunks.at(-1); assert.equal(finish?.type, 'finish');
  if (finish?.type !== 'finish') throw new Error('Missing finish');
  assert.deepEqual(finish.reason, { kind: 'tool-calls' });
  const o = options();
  o.messages.push({ id: 'a1', role: 'assistant', content: blocks, source: { kind: 'model', provider: 'siwc', model, replayState: finish.replayState } } as never);
  o.messages.push({ id: 't1', role: 'tool', content: [{ type: 'text', text: 'hello' }], toolCallId: 'call_1', source: { kind: 'tool', callId: 'call_1' } } as never);
  const wire = buildRequest(o), input = wire.input as Record<string, unknown>[];
  assert.equal(input.find(item => item.type === 'reasoning')?.encrypted_content, reasoning.encrypted_content);
  assert.deepEqual(input.at(-1), { type: 'function_call_output', call_id: 'call_1', output: 'hello' });
  assert.equal(wire.previous_response_id, undefined);
});

test('switching models rebuilds explicit text and tool history without old opaque reasoning or item IDs', () => {
  for (const includeCall of [false, true]) {
    const o = options(); o.model = 'another-account-model';
    const text = 'Previously read only the dummy file.', call = tool();
    const reasoning = { type: 'reasoning', id: 'rs_previous', summary: [], encrypted_content: 'synthetic-old-model-opaque', status: 'completed' };
    const output = [reasoning, message(text), ...(includeCall ? [call] : [])];
    const content = [{ type: 'text', text }, ...(includeCall ? [{ type: 'tool-call', id: call.call_id, name: call.name, arguments: call.arguments }] : [])];
    o.messages.push({ id: 'previous', role: 'assistant', content, source: { kind: 'model', provider: 'siwc', model,
      replayState: { response: { kind: 'siwc-responses', version: 1, model, output } } } } as never);
    if (includeCall) o.messages.push({ id: 'result', role: 'tool', content: [{ type: 'text', text: 'dummy file result' }], toolCallId: call.call_id,
      source: { kind: 'tool', callId: call.call_id } } as never);
    o.messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue with the newly selected model.' }] });
    const original = JSON.stringify(o.messages);
    const wire = buildRequest(o), input = wire.input as Record<string, unknown>[];
    assert.equal(wire.model, 'another-account-model');
    assert.deepEqual(input, [{ role: 'user', content: 'Read the dummy file.' }, { role: 'assistant', content: text },
      ...(includeCall ? [{ type: 'function_call', namespace: 'dsh', call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.call_id, output: 'dummy file result' }] : []),
      { role: 'user', content: 'Continue with the newly selected model.' }]);
    assert.equal(JSON.stringify(wire).includes(reasoning.encrypted_content), false);
    assert.equal(JSON.stringify(o.messages), original);
    // Switching back may reuse the original model's unchanged native reasoning.
    assert.equal((buildRequest({ ...o, model }).input as Record<string, unknown>[]).find(item => item.type === 'reasoning')?.encrypted_content, reasoning.encrypted_content);
  }
});

test('model switching preserves rejection of replay mismatches caused by changed or removed content', () => {
  for (const targetModel of [model, 'another-account-model']) {
    const o = options(); o.model = targetModel;
    const native = message('original text');
    o.messages.push({ id: 'previous', role: 'assistant', content: [{ type: 'text', text: 'compacted replacement' }], source: { kind: 'model', provider: 'siwc', model,
      replayState: { response: { kind: 'siwc-responses', version: 1, model, output: [native] } } } } as never);
    assert.throws(() => buildRequest(o), { code: 'INVALID_REPLAY_STATE' });
  }
});

test('text deltas are live; usage is not invented; terminal output must match streamed text', () => {
  const stream = new ResponseStream(model); const msg = message('hello');
  stream.accept(added(msg));
  const delta = stream.accept({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'hello' });
  assert.deepEqual(delta.map(chunk => chunk.type), ['block-start', 'text-delta']);
  stream.accept(done(msg)); const end = stream.accept(completed([msg]));
  assert.deepEqual(end.map(chunk => chunk.type), ['block-end', 'finish']); stream.end();
  assert.equal(mapUsage(undefined), undefined);
  const bad = new ResponseStream(model); bad.accept(added(msg));
  bad.accept({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'hel' }); bad.accept(done(msg));
  assert.throws(() => bad.accept(completed([msg])), { code: 'INVALID_STREAM' });
});

test('terminal full output may contain additional native items while every observed item remains matched', () => {
  const stream = new ResponseStream(model, new Set(['read_dummy']));
  const reasoning = { type: 'reasoning', id: 'rs_terminal', summary: [], encrypted_content: 'synthetic-terminal-opaque', status: 'completed' };
  const call = tool();
  stream.accept(added(call, 1)); stream.accept(done(call, 1));
  const chunks = stream.accept(completed([reasoning, call]));
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block),
    [{ type: 'tool-call', id: call.call_id, name: call.name, arguments: call.arguments }]);
  const finish = chunks.at(-1); assert.equal(finish?.type, 'finish');
  if (finish?.type !== 'finish') throw new Error('Missing finish');
  assert.deepEqual((finish.replayState as any).response.output, [reasoning, call]);
  stream.end();

  // A completed native message can also supply text when no delta was emitted.
  const text = new ResponseStream(model);
  assert.deepEqual(text.accept(completed([message('terminal text')])).map(chunk => chunk.type),
    ['block-start', 'text-delta', 'block-end', 'finish']);
});

test('real BlockAssembler display order replays across terminal-only earlier text and the next response', () => {
  const first = message('terminal first text'), second = { ...message('streamed second text'), id: 'msg_2' };
  const stream = new ResponseStream(model), assembler = new BlockAssembler();
  const push = (chunks: StreamChunk[]) => chunks.forEach(chunk => assembler.push(chunk));
  push(stream.accept(added(second, 1)));
  push(stream.accept({ type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: second.id, delta: 'streamed second text' }));
  push(stream.accept(done(second, 1))); push(stream.accept(completed([first, second])));
  const assembled = assembler.message({ provider: 'siwc', model, replayState: assembler.replayState });
  assert.deepEqual(assembled.content, [{ type: 'text', text: 'streamed second text' }, { type: 'text', text: 'terminal first text' }]);
  const native = (assembled.source.replayState as any).response.output;
  assert.deepEqual(native, [first, second]);
  for (const targetModel of [model, 'another-account-model']) {
    const o = options(); o.model = targetModel; o.messages.push(assembled);
    const input = buildRequest(o).input as Record<string, unknown>[];
    if (targetModel === model) assert.deepEqual(input.filter(item => item.type === 'message'), [first, second]);
    else assert.deepEqual(input.filter(item => item.role === 'assistant'),
      [{ role: 'assistant', content: 'streamed second text' }, { role: 'assistant', content: 'terminal first text' }]);
    const next = new ResponseStream(targetModel), nextAssembler = new BlockAssembler(), nextMessage = message('next answer');
    next.accept(completed([nextMessage])).forEach(chunk => nextAssembler.push(chunk));
    o.messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] }, nextAssembler.message({ provider: 'siwc', model: targetModel, replayState: nextAssembler.replayState }));
    assert.doesNotThrow(() => buildRequest(o));
    const changed = { ...assembled, content: [{ type: 'text', text: 'compacted replacement' }] };
    assert.throws(() => buildRequest({ ...o, messages: [o.messages[0], changed] } as GenerateOptions), { code: 'INVALID_REPLAY_STATE' });
    const injected = structuredClone(assembled) as any;
    injected.content.push({ type: 'text', text: 'unrelated old content' });
    injected.source.replayState.response.visible = structuredClone(injected.content);
    assert.throws(() => buildRequest({ ...o, messages: [o.messages[0], injected] }), { code: 'INVALID_REPLAY_STATE' });
  }
});

test('completed status with an error or incomplete details never releases a buffered tool', () => {
  for (const detail of [{ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { incomplete_details: { reason: 'max_output_tokens' } }]) {
    const stream = new ResponseStream(model, new Set(['read_dummy'])); const call = tool();
    assert.deepEqual(stream.accept(added(call)), []); assert.deepEqual(stream.accept(done(call)), []);
    const terminal = completed([]); Object.assign(terminal.response, detail);
    assert.throws(() => stream.accept(terminal), { code: 'error' in detail ? 'subscription_sharing_usage_limit_exceeded' : 'RESPONSE_INCOMPLETE' });
    assert.equal(stream.completed, false);
  }
});

test('completion never drops started items, trusts unfinished items, or changes a completed native item', () => {
  const call = tool();
  for (const index of [3]) {
    const stream = new ResponseStream(model, new Set(['read_dummy']));
    stream.accept(added(call, index)); stream.accept(done(call, index));
    assert.throws(() => stream.accept(completed([call])), (error: any) => {
      assert.equal(error.code, 'INVALID_STREAM');
      assert.match(error.message, /streamed_count=1/);
      assert.match(error.message, /completed_count=1/);
      return true;
    });
    assert.equal(stream.completed, false);
  }
  const missingDone = new ResponseStream(model, new Set(['read_dummy'])); missingDone.accept(added(call));
  assert.throws(() => missingDone.accept(completed([call])), { code: 'INVALID_STREAM' });
  const changed = new ResponseStream(model); const msg = message('preserved done text');
  changed.accept(added(msg)); changed.accept(done(msg));
  assert.throws(() => changed.accept(completed([message('changed terminal text')])), { code: 'INVALID_STREAM' });
  const opaque = new ResponseStream(model, new Set(['read_dummy']));
  const reasoning = { type: 'reasoning', id: 'rs_opaque', summary: [], encrypted_content: 'synthetic-done-opaque', status: 'completed' };
  opaque.accept(added(reasoning)); opaque.accept(done(reasoning));
  assert.throws(() => opaque.accept(completed([{ ...reasoning, encrypted_content: 'synthetic-changed-opaque' }, call])), { code: 'INVALID_STREAM' });
  for (const unfinished of [{ ...message(), status: 'in_progress' }, { type: 'reasoning', id: 'rs_unfinished', summary: [], status: 'incomplete' }]) {
    assert.throws(() => new ResponseStream(model).accept(completed([unfinished, message()])), { code: 'INVALID_STREAM' });
  }
  for (const malformed of [{ type: 'reasoning', id: 'rs_bad', summary: 'invalid' }, { type: 'unknown', id: 'unknown_item' }]) {
    assert.throws(() => new ResponseStream(model).accept(completed([malformed, message()])), { code: 'INVALID_STREAM' });
  }
});

test('empty terminal output uses only contiguous completed native items and preserves tool/reasoning replay', () => {
  const stream = new ResponseStream(model, new Set(['read_dummy']));
  const reasoning = { type: 'reasoning', id: 'rs_done', summary: [], encrypted_content: 'synthetic-finished-opaque', status: 'completed' };
  const first = tool(), second = tool('call_2', 'fc_2', '{"path":"second.txt"}'), msg = message('Done-stream text.');
  stream.accept(added(reasoning)); stream.accept(done(reasoning));
  stream.accept(added(first, 1));
  stream.accept({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: first.id, delta: '{"path":' });
  stream.accept({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: first.id, delta: '"dummy.txt"}' });
  stream.accept({ type: 'response.function_call_arguments.done', output_index: 1, item_id: first.id, arguments: first.arguments });
  stream.accept(done(first, 1)); stream.accept(added(second, 2)); stream.accept(done(second, 2));
  stream.accept(added(msg, 3)); stream.accept(done(msg, 3));
  const chunks = stream.accept(completed([]));
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block);
  assert.deepEqual(blocks, [{ type: 'text', text: 'Done-stream text.' },
    { type: 'tool-call', id: first.call_id, name: first.name, arguments: first.arguments },
    { type: 'tool-call', id: second.call_id, name: second.name, arguments: second.arguments }]);
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.argumentsDelta),
    ['{"path":', '"dummy.txt"}', second.arguments]);
  const finish = chunks.at(-1); assert.equal(finish?.type, 'finish');
  if (finish?.type !== 'finish') throw new Error('Missing finish');
  assert.deepEqual((finish.replayState as any).response.output, [reasoning, first, second, msg]);
  const o = options();
  o.messages.push({ id: 'a1', role: 'assistant', content: blocks, source: { kind: 'model', provider: 'siwc', model, replayState: finish.replayState } } as never);
  o.messages.push({ id: 't1', role: 'tool', content: [{ type: 'text', text: 'hello' }], toolCallId: first.call_id } as never);
  const input = buildRequest(o).input as Record<string, unknown>[];
  assert.equal(input.find(item => item.type === 'reasoning')?.encrypted_content, reasoning.encrypted_content);
  assert.deepEqual(input.at(-1), { type: 'function_call_output', call_id: first.call_id, output: 'hello' });
  stream.end();
});

test('empty terminal output still rejects missing done, gaps, partial calls and failed completion', () => {
  const call = tool();
  for (const setup of [
    (stream: ResponseStream) => stream.accept(added(call)),
    (stream: ResponseStream) => { stream.accept(added(call, 1)); stream.accept(done(call, 1)); },
  ]) {
    const stream = new ResponseStream(model, new Set(['read_dummy'])); setup(stream);
    assert.throws(() => stream.accept(completed([])), (error: any) => {
      assert.equal(error.code, 'INVALID_STREAM'); assert.match(error.message, /streamed_count=1;completed_count=0/); return true;
    });
    assert.equal(stream.completed, false);
  }
  const partial = new ResponseStream(model, new Set(['read_dummy'])); partial.accept(added(call));
  partial.accept({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: call.id, delta: '{"path":' });
  assert.throws(() => partial.accept(done(call)), { code: 'INVALID_TOOL_CALL' });
  assert.throws(() => partial.accept(completed([])), { code: 'INVALID_STREAM' });
  for (const terminal of [{ type: 'response.failed', response: { error: { code: 'server_error' } } }, { type: 'response.incomplete' }]) {
    const stream = new ResponseStream(model, new Set(['read_dummy'])); stream.accept(added(call)); stream.accept(done(call));
    assert.throws(() => stream.accept(terminal)); assert.equal(stream.completed, false);
  }
  const interrupted = new ResponseStream(model, new Set(['read_dummy'])); interrupted.accept(added(call)); interrupted.accept(done(call));
  assert.throws(() => interrupted.end(), { code: 'STREAM_INTERRUPTED' });
});

test('failed/incomplete/disconnected or malformed calls never release a tool chunk', () => {
  for (const terminal of [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }, { type: 'response.incomplete' }]) {
    const stream = new ResponseStream(model, new Set(['read_dummy'])); stream.accept(added(tool()));
    assert.throws(() => stream.accept(terminal)); assert.equal(stream.completed, false);
  }
  const partial = new ResponseStream(model, new Set(['read_dummy'])); partial.accept(added(tool()));
  assert.throws(() => partial.end(), { code: 'STREAM_INTERRUPTED' });
  for (const invalid of [tool('call_1', 'fc_1', '{broken'), { ...tool(), namespace: 'other' }, { ...tool(), name: 'undeclared' }]) {
    const stream = new ResponseStream(model, new Set(['read_dummy'])); stream.accept(added(invalid));
    assert.throws(() => stream.accept(done(invalid))); assert.equal(stream.completed, false);
  }
  const reordered = new ResponseStream(model, new Set(['read_dummy'])); reordered.accept({ ...added(tool()), sequence_number: 4 });
  assert.throws(() => reordered.accept({ type: 'response.in_progress', sequence_number: 3 }), { code: 'INVALID_STREAM' });
});

test('SSE handles split UTF-8/CRLF and cancels the reader; HTTP 200 and DONE are insufficient', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"type":"response.in_progress","value":"日本語"}\r\n\r\ndata: [DONE]\r\n\r\n');
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); }, cancel() { cancelled++; } });
  const iterator = readSse(body); const item = await iterator.next(); assert.equal(item.value?.value, '日本語');
  await iterator.return(undefined); assert.equal(cancelled, 1); assert.equal(body.locked, false);
  const stream = new ResponseStream(model); assert.throws(() => stream.end(), { code: 'STREAM_INTERRUPTED' });
  const malformed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {broken}\n\n')); controller.close(); } });
  await assert.rejects(async () => { for await (const _ of readSse(malformed)) {} }, { code: 'INVALID_STREAM' });
});

test('cancelled blocked SSE reads settle and release resources', async () => {
  const controller = new AbortController(); let cancels = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancels++; } });
  const run = (async () => { for await (const _ of readSse(body, controller.signal)) {} })();
  controller.abort(); await assert.rejects(run, { code: 'CANCELLED' });
  assert.equal(cancels, 1); assert.equal(body.locked, false);
});

test('usage counters are disjoint and sanitized errors retain safe shape/code/param without provider text', () => {
  assert.deepEqual(mapUsage({ input_tokens: 30, output_tokens: 8, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 38 }),
    { inputTokens: 23, outputTokens: 8, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 3, totalTokens: 38 });
  assert.equal(mapUsage({ input_tokens: 2, output_tokens: 1, input_tokens_details: { cached_tokens: 3 } }), undefined);
  for (const body of [{ detail: 'FAKE_SECRET echoed' }, { error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[0]', message: 'FAKE_SECRET' } }]) {
    const error = providerFailure(body, 400, 'req_fixture');
    assert.equal(error.message.includes('FAKE_SECRET'), false); assert.equal(error.requestId, 'req_fixture');
    assert.equal(error.responseShape, 'detail' in body ? 'detail' : 'structured_error');
  }
});

test('protocol failures identify only safe event types and schema locations, never payload values', async () => {
  const secret = 'FAKE_PRIVATE_PAYLOAD_VALUE';
  const safeError = (action: () => unknown, code: string, reason: RegExp) => assert.throws(action, (error: any) => {
    assert.equal(error.code, code); assert.match(error.message, reason);
    assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(secret), false); return true;
  });
  safeError(() => new ResponseStream(model).accept({ type: 'response.future_event', delta: secret, encrypted_content: secret }),
    'UNSUPPORTED_STREAM_EVENT', /event\.type=response\.future_event/);
  safeError(() => new ResponseStream(model).accept({ type: `response.future?token=${secret}`, arguments: secret }),
    'UNSUPPORTED_STREAM_EVENT', /event\.type=redacted/);
  safeError(() => new ResponseStream(model).accept({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: '', text: secret } }),
    'INVALID_STREAM', /output_item_added\.item_id_invalid/);
  const indexed = new ResponseStream(model); indexed.accept({ ...added(message()), sequence_number: 5 });
  safeError(() => indexed.accept({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: secret, delta: secret, sequence_number: 6 }),
    'INVALID_STREAM', /event_item\.item_id_mismatch/);
  const sequence = new ResponseStream(model); sequence.accept({ type: 'response.in_progress', sequence_number: 8 });
  safeError(() => sequence.accept({ type: 'response.in_progress', sequence_number: 8, detail: secret }),
    'INVALID_STREAM', /sequence_number_not_increasing/);
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: {${secret}}\n\n`)); controller.close(); } });
  await assert.rejects(async () => { for await (const _ of readSse(body)) {} }, (error: any) => {
    assert.equal(error.code, 'INVALID_STREAM'); assert.match(error.message, /sse\.json_invalid/);
    assert.equal(`${error.message} ${JSON.stringify(error)}`.includes(secret), false); return true;
  });
});
