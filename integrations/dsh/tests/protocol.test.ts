import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockAssembler, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { buildRequest, mapUsage, Notes, providerFailure, readSse, ResponseStream, wireToolName } from '../lib/protocol.js';

const model = 'gpt-6.1-sol';
const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
const base = (extra: Partial<GenerateOptions> = {}): GenerateOptions => ({ provider: 'siwc', model, messages: [user('hello')], ...extra });
const message = (text: string, id = 'msg_1') => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const call = (id = 'call_1', args = '{"path":"a.txt"}') => ({ type: 'function_call', id: `fc_${id}`, call_id: id, namespace: 'dsh', name: 'read', arguments: args, status: 'completed' });
const reasoning = (summary = 'thinking about it') => ({ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: summary }], encrypted_content: 'synthetic-opaque' });
const completed = (output: unknown[], usage?: unknown) => ({ type: 'response.completed', response: { status: 'completed', output, ...(usage ? { usage } : {}) } });
const assemble = (chunks: StreamChunk[]) => { const assembler = new BlockAssembler(); for (const chunk of chunks) assembler.push(chunk); return assembler; };

// ---------- request building ----------

test('request: store false, stream true, developer instructions, namespaced tools, encrypted reasoning included', () => {
  const body = buildRequest(base({ system: 'Be careful.', tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] }));
  assert.equal(body.store, false); assert.equal(body.stream, true);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual((body.input as unknown[])[0], { role: 'developer', content: 'Be careful.' });
  const tools = body.tools as any[];
  assert.equal(tools[0].type, 'namespace'); assert.equal(tools[0].name, 'dsh'); assert.equal(tools[0].tools[0].name, 'read');
  // Fields the ChatGPT-plan route rejects are never sent.
  for (const field of ['temperature', 'max_output_tokens', 'top_p', 'truncation', 'previous_response_id', 'service_tier', 'prompt_cache_retention', 'metadata', 'user']) assert.equal(field in body, false, field);
});

test('request: options the route does not support are left out and noted instead of failing the turn', () => {
  const notes = new Notes();
  const body = buildRequest({ ...base(), temperature: 0.2, maxTokens: 50, stop: ['x'] } as GenerateOptions, { notes });
  assert.equal('temperature' in body, false); assert.equal('max_output_tokens' in body, false);
  assert.deepEqual(notes.list().sort(), ['request.option_omitted.maxTokens', 'request.option_omitted.stop', 'request.option_omitted.temperature']);
});

test('request: reasoning summary is always requested for documented models; an unlisted effort falls back to the default', () => {
  assert.deepEqual(buildRequest(base()).reasoning, { summary: 'auto' });
  assert.deepEqual(buildRequest(base({ reasoningEffort: ReasoningEffortId('max') })).reasoning, { effort: 'max', summary: 'auto' });
  const notes = new Notes();
  assert.deepEqual(buildRequest(base({ reasoningEffort: ReasoningEffortId('none') }), { notes }).reasoning, { summary: 'auto' });
  assert.deepEqual(notes.list(), ['request.reasoning_effort_omitted']);
  assert.equal(buildRequest(base({ model: 'unknown-model' })).reasoning, undefined);
});

test('request: system history becomes developer; empty text is not sent', () => {
  const body = buildRequest(base({ messages: [{ role: 'system', content: [{ type: 'text', text: 'Rules' }] }, user(''), user('hi')] }));
  assert.deepEqual(body.input, [{ role: 'developer', content: 'Rules' }, { role: 'user', content: 'hi' }]);
});

test('request: an open tool call is closed with a placeholder, an orphan result is kept as context, duplicates are skipped', () => {
  const notes = new Notes();
  const body = buildRequest(base({ messages: [
    user('start'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: { provider: 'siwc', model } },
    user('cancelled, try again'),
    { role: 'tool', toolCallId: 'ghost', content: [{ type: 'text', text: 'late result' }] },
  ] } as unknown as GenerateOptions), { notes });
  const input = body.input as any[];
  assert.equal(input.filter(item => item.type === 'function_call').length, 1);
  const closeIndex = input.findIndex(item => item.type === 'function_call_output' && item.call_id === 'c1');
  assert.ok(closeIndex > 0 && closeIndex < input.findIndex(item => item.content === 'cancelled, try again'));
  assert.ok(input.some(item => item.role === 'user' && String(item.content).includes('late result')));
  assert.deepEqual(notes.list().sort(), ['request.duplicate_call_skipped', 'request.open_call_closed', 'request.orphan_tool_result']);
});

test('request: native items are reused only for the same registration, model and unchanged content; otherwise plain history', () => {
  const stream = new ResponseStream(model, new Notes(), 'reg-a');
  const chunks = [...stream.accept({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'answer' }), ...stream.accept(completed([reasoning(), message('answer')]))];
  const assistant = assemble(chunks).message({ provider: 'siwc', model, replayState: (chunks.at(-1) as any).replayState });
  const history = (extra: Partial<GenerateOptions> = {}) => base({ messages: [user('q'), assistant, user('next')], ...extra });
  const same = buildRequest(history(), { registrationId: 'reg-a' }).input as any[];
  assert.ok(same.some(item => item.type === 'reasoning' && item.encrypted_content === 'synthetic-opaque'));
  for (const [options, context, note] of [[history(), { registrationId: 'reg-b' }, 'replay.other_registration'], [history({ model: 'gpt-6-sol' }), { registrationId: 'reg-a' }, 'replay.other_model']] as const) {
    const notes = new Notes();
    const input = buildRequest(options, { ...context, notes }).input as any[];
    assert.equal(input.some(item => item.type === 'reasoning'), false);
    assert.ok(input.some(item => item.role === 'assistant' && item.content === 'answer'));
    assert.deepEqual(notes.list(), [note]);
  }
  const edited = structuredClone(assistant);
  const textBlock = edited.content.find(block => block.type === 'text') as { text: string };
  textBlock.text = 'compacted';
  const notes = new Notes();
  const input = buildRequest(base({ messages: [user('q'), edited, user('next')] }), { registrationId: 'reg-a', notes }).input as any[];
  assert.ok(input.some(item => item.role === 'assistant' && item.content === 'compacted'));
  assert.deepEqual(notes.list(), ['replay.content_changed']);
});

// ---------- response stream ----------

test('stream: text and reasoning summaries stream live; tool calls are released only after completion', () => {
  const stream = new ResponseStream(model);
  const live: StreamChunk[] = [];
  live.push(...stream.accept({ type: 'response.created', response: {} }));
  live.push(...stream.accept({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } }));
  live.push(...stream.accept({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Plan: ' }));
  live.push(...stream.accept({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'read it' }));
  live.push(...stream.accept({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_call_1', call_id: 'call_1', name: 'read', arguments: '' } }));
  live.push(...stream.accept({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' }));
  assert.ok(live.some(chunk => chunk.type === 'reasoning-delta'));
  assert.equal(live.some(chunk => chunk.type === 'tool-call-delta'), false, 'no tool call before completion');
  const final = stream.accept(completed([reasoning('Plan: read it'), call()]));
  const tool = final.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call') as any;
  assert.deepEqual(tool.block, { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' });
  assert.equal((final.at(-1) as any).reason.kind, 'tool-calls');
  const assembled = assemble([...live, ...final]).message({ provider: 'siwc', model });
  assert.equal(assembled.content[0]!.type, 'reasoning');
});

test('stream: unknown events, including ones outside the Responses namespace, are skipped and noted', () => {
  const notes = new Notes();
  const stream = new ResponseStream(model, notes);
  for (const type of ['codex.rate_limits', 'keepalive', 'response.future_event', 'weird?type=x']) assert.deepEqual(stream.accept({ type, anything: 'SECRET_VALUE' }), []);
  stream.accept({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ok' });
  const final = stream.accept(completed([message('ok')]));
  assert.equal((final.at(-1) as any).reason.kind, 'stop');
  assert.deepEqual(notes.list(), ['stream.skipped_event.codex.rate_limits', 'stream.skipped_event.keepalive', 'stream.skipped_event.response.future_event', 'stream.skipped_event.redacted']);
  assert.equal(notes.list().join().includes('SECRET_VALUE'), false);
});

test('stream: a final text that differs from what streamed keeps what the user saw and is only noted', () => {
  const notes = new Notes();
  const stream = new ResponseStream(model, notes);
  stream.accept({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello' });
  const final = stream.accept(completed([message('Hello world')]));
  assert.deepEqual((final.find(chunk => chunk.type === 'block-end') as any).block, { type: 'text', text: 'Hello' });
  assert.deepEqual(notes.list(), ['stream.final_text_differs']);
});

test('stream: text that never streamed is emitted from the completed response; empty output uses finished items', () => {
  const plain = new ResponseStream(model).accept(completed([message('from final')]));
  assert.ok(plain.some(chunk => chunk.type === 'text-delta' && chunk.text === 'from final'));
  const stream = new ResponseStream(model);
  stream.accept({ type: 'response.output_item.added', output_index: 0, item: { ...call(), arguments: '' } });
  stream.accept({ type: 'response.output_item.done', output_index: 0, item: call() });
  const chunks = stream.accept(completed([]));
  assert.ok(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'));
});

test('stream: errors fail the turn with safe codes; incomplete keeps a long answer but never runs its tools', () => {
  assert.throws(() => new ResponseStream(model).accept({ type: 'error', code: 'server_error', message: 'SECRET_ECHO' }), (error: any) => error.code === 'server_error' && !error.message.includes('SECRET_ECHO'));
  assert.throws(() => new ResponseStream(model).accept({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'SECRET_ECHO' } } }), { code: 'subscription_sharing_usage_limit_exceeded' });
  const long = new ResponseStream(model);
  long.accept({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'very long' });
  long.accept({ type: 'response.output_item.added', output_index: 1, item: { ...call(), arguments: '' } });
  const chunks = long.accept({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } });
  assert.equal((chunks.at(-1) as any).reason.kind, 'max-tokens');
  assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), false);
  assert.throws(() => new ResponseStream(model).accept({ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }), { code: 'CONTENT_FILTERED' });
});

test('stream: an empty completion and a stream that ends early are retryable failures', () => {
  assert.throws(() => new ResponseStream(model).accept(completed([])), { code: 'EMPTY_RESPONSE' });
  const stream = new ResponseStream(model);
  stream.accept({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' });
  assert.throws(() => stream.end(), { code: 'STREAM_INTERRUPTED' });
});

test('stream: completion carries registration-bound replay state and usage; later events are ignored', () => {
  const stream = new ResponseStream(model, new Notes(), 'reg-a');
  stream.accept({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'answer' });
  const chunks = stream.accept(completed([reasoning(), message('answer')], { input_tokens: 30, output_tokens: 8, input_tokens_details: { cached_tokens: 5 }, total_tokens: 38 }));
  const finish = chunks.at(-1) as any;
  assert.equal(finish.replayState.response.registrationId, 'reg-a');
  assert.equal(finish.replayState.response.version, 2);
  assert.deepEqual(finish.replayState.response.visible, [{ type: 'text', text: 'answer' }]);
  assert.deepEqual((chunks.find(chunk => chunk.type === 'usage') as any).usage, { inputTokens: 25, outputTokens: 8, cacheReadTokens: 5, totalTokens: 38 });
  assert.deepEqual(stream.accept({ type: 'response.output_text.delta', delta: 'late' }), []);
});

// ---------- SSE and helpers ----------

const encoder = new TextEncoder();
const body = (...parts: (string | Uint8Array)[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part); controller.close(); } });

test('SSE: split UTF-8, CRLF, comments, unknown fields and [DONE] are handled; unparsable frames are skipped', async () => {
  const json = encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '日本語' })}\r\n\r\n`);
  const notes = new Notes();
  const events: Record<string, unknown>[] = [];
  for await (const event of readSse(body(': comment\n', 'id: 1\nretry: 5\nevent: x\n', 'data: {"type":"a"}\n\n', json.slice(0, 40), json.slice(40), 'data: {not json\n\n', 'data: [DONE]\n\n'), undefined, notes)) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['a', 'response.output_text.delta']);
  assert.equal(events[1]!.delta, '日本語');
  assert.deepEqual(notes.list(), ['sse.unparsable_frame']);
});

test('SSE: cancellation settles as CANCELLED and a broken stream as STREAM_INTERRUPTED', async () => {
  const controller = new AbortController();
  const stalled = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
  const reading = (async () => { for await (const _ of readSse(stalled, controller.signal)) { /* none */ } })();
  controller.abort();
  await assert.rejects(reading, { code: 'CANCELLED' });
  const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error('socket reset')); } });
  await assert.rejects((async () => { for await (const _ of readSse(broken)) { /* none */ } })(), { code: 'STREAM_INTERRUPTED' });
});

test('usage mapping is disjoint and tolerant; provider failures keep codes but never provider text', () => {
  assert.deepEqual(mapUsage({ input_tokens: 30, output_tokens: 8, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 38 }),
    { inputTokens: 23, outputTokens: 8, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 3, totalTokens: 38 });
  assert.equal(mapUsage(undefined), undefined);
  const failure = providerFailure({ error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[0]', message: 'SECRET_ECHO' } }, 400, 'req_fixture');
  assert.equal(failure.code, 'subscription_sharing_unsupported_capability'); assert.equal(failure.param, 'tools[0]'); assert.equal(failure.requestId, 'req_fixture');
  assert.equal(JSON.stringify(failure).includes('SECRET_ECHO') || failure.message.includes('SECRET_ECHO'), false);
  assert.equal(providerFailure({ detail: 'Unsupported service_tier: fast' }, 400).code, 'provider_error');
});

test('tool names the service does not accept are sent under a stable alias and mapped back', () => {
  const original = 'mcp.files/read text';
  const alias = wireToolName(original);
  assert.match(alias, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(wireToolName(original), alias);
  assert.equal(wireToolName('read_file'), 'read_file');
  const toolNames = new Map<string, string>();
  const body = buildRequest({ provider: 'siwc', model: 'gpt-6.1-sol', tools: [{ name: original, description: 'd', parameters: { type: 'object', properties: {} } }, { name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: original, arguments: '{}' }], source: { provider: 'siwc', model: 'gpt-6.1-sol' } },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }] } as never, { toolNames });
  const tools = (body.tools as any[])[0].tools.map((tool: any) => tool.name);
  assert.deepEqual(tools, [alias, 'read']);
  assert.equal((body.input as any[]).find(item => item.type === 'function_call').name, alias);
  assert.equal(toolNames.get(alias), original);
  const stream = new ResponseStream('gpt-6.1-sol', undefined, undefined, toolNames);
  stream.accept({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_2', name: alias, arguments: '{}' } });
  const chunks = stream.accept({ type: 'response.completed', response: { status: 'completed', output: [] } });
  assert.equal((chunks.find(chunk => chunk.type === 'block-end') as any).block.name, original);
});

// ---------- release of tool calls (only whole, offered calls of a completed response) ----------

test('tools are released only from a whole response: offered name, own namespace, completed call, JSON-object arguments', () => {
  const offered = new Set(['read']);
  const release = (output: unknown[], status: string | undefined = 'completed') =>
    new ResponseStream(model, new Notes(), 'reg-a', new Map(), offered).accept({ type: 'response.completed', response: { ...(status ? { status } : {}), output } });
  assert.equal((release([call()]).at(-1) as any).reason.kind, 'tool-calls');
  for (const [bad, reason] of [[{ ...call(), name: 'write' }, 'not_offered'], [{ ...call(), namespace: 'other' }, 'other_namespace'], [{ ...call(), status: 'in_progress' }, 'not_completed'],
    [call('call_1', '{"path":'), 'arguments_not_json'], [call('call_1', '["a"]'), 'arguments_not_object']] as const) {
    assert.throws(() => release([message('text'), bad]), (error: any) => error.code === 'INVALID_TOOL_CALL' && error.message.includes(reason), reason);
  }
  // response.completed whose response is not completed never releases tools.
  assert.throws(() => release([call()], 'failed'), { code: 'RESPONSE_INCOMPLETE' });
  assert.throws(() => release([call()], 'incomplete'), (error: any) => error.code === 'RESPONSE_INCOMPLETE');
  // A call that was started but never finished withholds the answer's tools.
  const stream = new ResponseStream(model, new Notes(), 'reg-a', new Map(), offered);
  stream.accept({ type: 'response.output_item.added', output_index: 0, item: { ...call(), status: 'in_progress', arguments: '' } });
  assert.throws(() => stream.accept(completed([])), (error: any) => error.code === 'INVALID_TOOL_CALL' && error.message.includes('not_done'));
});
