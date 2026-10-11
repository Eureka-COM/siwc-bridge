import { writeFileSync } from 'node:fs';

export const name = 'siwc-mock-adapter';
export const inject = ['llm'];
const fakeToken = 'siwc-fixture-only-never-a-real-credential';
const encode = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

/** Test subprocess only: no production auth/store imports and no outbound transport. */
export async function apply(ctx, config) {
  const facts = { modelRequests: 0, inferenceRequests: 0, requests: [] };
  const persist = () => writeFileSync(config.evidencePath, JSON.stringify(facts, null, 2) + '\n', 'utf8');
  const original = globalThis.fetch;
  const mockFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (headers.get('authorization') !== `Bearer ${fakeToken}`) throw new Error('Mock transport refuses all credentials except its fixed fixture token.');
    init.signal?.throwIfAborted();
    if (url === 'https://api.openai.com/v1/models' && (!init.method || init.method === 'GET')) {
      facts.modelRequests += 1; persist();
      return Response.json({ models: [{ slug: config.model, display_name: 'SIWC fixture model', visibility: 'list' }] });
    }
    if (url !== 'https://api.openai.com/v1/responses' || init.method !== 'POST') throw new Error('Mock transport rejects every other URL and method; no network fallback exists.');
    const body = JSON.parse(init.body); facts.inferenceRequests += 1;
    facts.requests.push({ body, attribution: headers.has('user-agent') }); persist();
    if (facts.inferenceRequests > 2) throw new Error('Fixture inference budget exceeded.');
    let output; let events;
    if (facts.inferenceRequests === 1) {
      const namespace = body.tools?.find(tool => tool.type === 'namespace')?.name;
      const item = { type: 'function_call', id: 'fc_fixture', status: 'completed', call_id: 'call_fixture', name: 'read',
        ...(namespace ? { namespace } : {}), arguments: JSON.stringify({ file_path: config.dummyPath, offset: 1, limit: 5 }) };
      output = [item];
      const split = Math.floor(item.arguments.length / 2);
      events = [
        { type: 'response.created', response: { id: 'resp_fixture_1', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments.slice(0, split) },
        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments.slice(split) },
        { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments },
        { type: 'response.output_item.done', output_index: 0, item },
      ];
      if (config.scenario === 'disconnected') return new Response(events.map(encode).join(''), { headers: { 'content-type': 'text/event-stream' } });
    } else {
      const result = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'call_fixture');
      const outputText = typeof result?.output === 'string' ? result.output : JSON.stringify(result?.output);
      const marker = outputText?.match(/DSH_MOCK_VALUE=[a-f0-9]{32}/)?.[0];
      if (!marker) throw new Error('Second inference did not receive the actual dsh read result.');
      const text = `dsh read result: ${marker}`;
      output = [{ type: 'message', id: 'msg_fixture', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }];
      events = [
        { type: 'response.created', response: { id: 'resp_fixture_2', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...output[0], status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg_fixture', part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_fixture', delta: text },
        { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: 'msg_fixture', text },
        { type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: 'msg_fixture', part: output[0].content[0] },
        { type: 'response.output_item.done', output_index: 0, item: output[0] },
      ];
    }
    events.push({ type: 'response.completed', response: { id: `resp_fixture_${facts.inferenceRequests}`, status: 'completed', output,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    return new Response(events.map(encode).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' } });
  };
  globalThis.fetch = mockFetch;
  ctx.effect(() => () => { if (globalThis.fetch === mockFetch) globalThis.fetch = original; persist(); });
  persist();
  const { SiwcAdapter } = await import('../../lib/adapter.js');
  class FixtureCredentialSource {
    async status() { return { activeId: 'mock-registration' }; }
    async withAccessToken(callback) { return callback(fakeToken, undefined, 'mock-registration'); }
  }
  const adapter = new SiwcAdapter(new FixtureCredentialSource());
  ctx.llm.registerAdapter([config.provider], adapter);
}
