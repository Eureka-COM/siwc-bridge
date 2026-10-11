import { SiwcClient } from '../lib/index.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// This example is mock-only. It cannot sign in or call a live model.
if (!process.argv.includes('--mock')) throw new Error('この例は --mock 専用です。ライブ通信は行いません。');
const directory = await mkdtemp(join(tmpdir(), 'siwc-bridge-example-'));
const file = join(directory, 'dummy.txt');
const marker = `dummy-${randomUUID()}`;
await writeFile(file, marker, 'utf8');
const originalFetch = globalThis.fetch;
const requests = [];
let inference = 0; let tools = 0;
const call = { type: 'function_call', id: 'fc_fixture', namespace: 'local', call_id: 'call_fixture', name: 'read_dummy', arguments: '{}', status: 'completed' };
const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'synthetic-opaque-test-only' };
const completeStream = output => {
  const events = output.flatMap((item, output_index) => [
    { type: 'response.output_item.added', output_index, item: { ...item, ...(item.type === 'function_call' ? { arguments: '', status: 'in_progress' } : {}) } },
    ...(item.type === 'function_call' ? [{ type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: item.arguments }] : []),
    { type: 'response.output_item.done', output_index, item },
  ]);
  events.push({ type: 'response.completed', response: { status: 'completed', output } });
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
try {
  globalThis.fetch = async (url, init) => {
    if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }] });
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body); requests.push(body); inference++;
    assert.equal(body.store, false); assert.equal(body.stream, true);
    if (inference === 1) return completeStream([reasoning, call]);
    assert.equal(inference, 2);
    assert.ok(body.input.some(item => item.type === 'reasoning' && item.encrypted_content === reasoning.encrypted_content));
    const result = body.input.find(item => item.type === 'function_call_output');
    assert.equal(result.call_id, call.call_id); assert.equal(result.output, marker);
    return completeStream([{ type: 'message', role: 'assistant', id: 'msg_fixture', status: 'completed', content: [{ type: 'output_text', text: result.output, annotations: [] }] }]);
  };
  const client = new SiwcClient({ withAccessToken: operation => operation('synthetic-test-only') }, { beforeRequest: async () => {} });
  const input = [{ role: 'user', content: 'read_dummyを1回呼び、結果の値を最終回答で返してください。' }];
  const options = { model: 'fixture-model', input, tools: [{ type: 'namespace', name: 'local', tools: [
    { type: 'function', name: 'read_dummy', description: 'Read the dedicated dummy file', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: false },
  ] }] };
  const first = await client.complete(options);
  assert.equal(JSON.stringify(requests[0]).includes(marker), false);
  input.push(...first.output);
  const functionCall = first.output.find(item => item.type === 'function_call');
  assert.equal(functionCall.name, 'read_dummy');
  const result = await readFile(file, 'utf8'); tools++;
  input.push({ type: 'function_call_output', call_id: functionCall.call_id, output: result });
  const final = await client.complete(options);
  assert.equal(final.output[0].content[0].text, marker);
  console.log(JSON.stringify({ kind: 'mock', inferenceRequests: inference, localReads: tools, resultReturned: true, opaqueReasoningPreserved: true, finalAnswer: 'PASS', liveAccount: 'NOT_RUN' }));
} finally { globalThis.fetch = originalFetch; }
