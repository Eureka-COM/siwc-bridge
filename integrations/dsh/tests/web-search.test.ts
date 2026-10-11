import test from 'node:test';
import assert from 'node:assert/strict';
import { SiwcAdapter } from '../lib/adapter.js';
import { SearchCollector, SiwcSearchProvider, cleanUrl, searchRequest, SEARCH_PROVIDER_ID } from '../lib/web-search.js';
import type { Diagnostics } from '../lib/diagnostics.js';

const model = 'gpt-6.1-sol';
const sse = (...events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_search' } });
function credentials() {
  return { status: async () => ({ activeId: 'reg-a', registrations: [{ id: 'reg-a', authenticated: true, planAllowed: true, planConfirmed: true }] }),
    withAccessToken: async (operation: any) => operation('synthetic-test-only', undefined, 'reg-a') };
}
function memoryDiagnostics(): Diagnostics & { lines: string[] } {
  const lines: string[] = [];
  return { lines, location: 'memory', record(fields) { lines.push(Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ')); }, async tail() { return lines; } };
}
function mockFetch(t: test.TestContext, handler: () => Response | Promise<Response>) {
  const calls: { url: string; body?: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => { calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined }); return handler(); });
  return calls;
}

// The shape recorded from the real plan route: items arrive in output_item.done, the final output is empty.
const summary = 'Node.js 24 entered LTS on 2025-10-28 ([nodejs.org](https://nodejs.org/en/blog/release/v24.11.0?utm_source=openai)). The schedule is kept on GitHub ([github.com](https://github.com/nodejs/Release?utm_source=openai)).';
const first = summary.indexOf('(['), second = summary.lastIndexOf('([');
const searchEvents = () => [
  { type: 'response.created', response: {} },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } },
  { type: 'response.web_search_call.in_progress', output_index: 0 },
  { type: 'response.web_search_call.searching', output_index: 0 },
  { type: 'response.web_search_call.completed', output_index: 0 },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'q', sources: [
    { type: 'url', url: 'https://github.com/nodejs/Release' }, { type: 'url', url: 'https://nodejs.org/en/about/previous-releases' }, { type: 'url', url: 'javascript:alert(1)' }] } } },
  { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: summary },
  { type: 'response.output_text.annotation.added', output_index: 1 },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: summary, annotations: [
    { type: 'url_citation', url: 'https://nodejs.org/en/blog/release/v24.11.0?utm_source=openai', title: 'Node.js 24.11.0 (LTS)', start_index: first, end_index: summary.indexOf(')', first) + 2 },
    { type: 'url_citation', url: 'https://github.com/nodejs/Release?utm_source=openai', title: 'nodejs/Release', start_index: second, end_index: summary.length - 1 }] }] } },
  { type: 'response.completed', response: { status: 'completed', output: [] } },
];

test('a search result carries the cited pages first (title and the sentence they support), then the other pages opened, without the OpenAI tracking tag', () => {
  const collector = new SearchCollector();
  for (const event of searchEvents()) collector.accept(event);
  assert.equal(collector.completed, true);
  const result = collector.result(8);
  assert.deepEqual(result.sources.map(source => source.url), ['https://nodejs.org/en/blog/release/v24.11.0', 'https://github.com/nodejs/Release', 'https://nodejs.org/en/about/previous-releases']);
  assert.equal(result.sources[0]!.title, 'Node.js 24.11.0 (LTS)');
  assert.equal(result.sources[0]!.snippet, 'Node.js 24 entered LTS on 2025-10-28');
  assert.equal(result.sources[2]!.title, undefined);
  assert.equal(result.content?.includes('utm_source'), false);
  assert.equal(result.truncated, false);
  const capped = collector.result(2);
  assert.equal(capped.sources.length, 2); assert.equal(capped.truncated, true);
  assert.equal(cleanUrl('ftp://example.org/archive'), undefined); assert.equal(cleanUrl('javascript:alert(1)'), undefined);
  assert.equal(cleanUrl('https://example.org/a?utm_source=openai&b=1'), 'https://example.org/a?b=1');
});

test('the request searches through the hosted tool with the ChatGPT-plan rules, and the diagnostics line has labels only', async t => {
  const calls = mockFetch(t, () => sse(...searchEvents()));
  const diagnostics = memoryDiagnostics();
  const adapter = new SiwcAdapter(credentials(), { diagnostics });
  const result = await adapter.webSearch({ query: 'secret query text', maxResults: 5, model });
  assert.equal(result.sources.length, 3);
  const body = calls[0]!.body;
  assert.equal(calls[0]!.url, 'https://api.openai.com/v1/responses');
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.model, model);
  assert.deepEqual(body.tools, [{ type: 'web_search' }]); assert.equal(body.tool_choice, 'required');
  assert.deepEqual(body.include, ['web_search_call.action.sources']); assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal(body.input[0].role, 'user'); assert.equal(body.input.some((item: any) => item.role === 'system'), false);
  for (const key of ['temperature', 'top_p', 'max_output_tokens', 'previous_response_id']) assert.equal(key in body, false, key);
  assert.equal(diagnostics.lines.length, 1);
  assert.match(diagnostics.lines[0]!, /^kind=search model=gpt-6\.1-sol outcome=ok http=200 request_id=req_search/);
  assert.equal(diagnostics.lines[0]!.includes('secret query'), false);
  assert.equal(searchRequest('q', 'unlisted-model').reasoning, undefined);
});

test('search failures: not completed, failed, refused by policy, usage limit (pauses), empty query — none returns a partial result', async t => {
  let response: () => Response = () => sse(...searchEvents());
  const calls = mockFetch(t, () => response());
  const adapter = new SiwcAdapter(credentials());
  response = () => sse(...searchEvents().slice(0, -1));
  await assert.rejects(adapter.webSearch({ query: 'q', model }), { code: 'TRANSPORT' });
  response = () => sse({ type: 'response.failed', response: { error: { code: 'server_error' } } });
  await assert.rejects(adapter.webSearch({ query: 'q', model }), { code: 'SERVER' });
  response = () => Response.json({ error: { code: 'subscription_sharing_unsupported_capability', param: 'tools' } }, { status: 400 });
  await assert.rejects(adapter.webSearch({ query: 'q', model }), (error: any) => error.code === 'SEARCH_UNAVAILABLE' && /Web検索を使えません/.test(error.message));
  const before = calls.length;
  await assert.rejects(adapter.webSearch({ query: '   ', model }), (error: any) => /検索語が空/.test(error.message));
  assert.equal(calls.length, before, 'an empty query is not sent');
  response = () => Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429 });
  await assert.rejects(adapter.webSearch({ query: 'q', model }), { code: 'QUOTA' });
  assert.equal(adapter.isPaused(), true);
  const paused = calls.length;
  await assert.rejects(adapter.webSearch({ query: 'q', model }), (error: any) => error.code === 'QUOTA' && /\/siwc resume/.test(error.message));
  assert.equal(calls.length, paused, 'no search is sent while paused');
  adapter.resume(); response = () => sse(...searchEvents());
  assert.equal((await adapter.webSearch({ query: 'q', model })).sources.length, 3);
});

test('the provider searches with the model of the asking conversation, and explains when no ChatGPT-plan model is known', async () => {
  const seen: any[] = [];
  const engine = { webSearch: async (request: any) => { seen.push(request); return { sources: [], truncated: false }; } };
  const provider = new SiwcSearchProvider(engine, async () => 'gpt-6-astra');
  assert.equal(provider.id, SEARCH_PROVIDER_ID); assert.equal(provider.available(), true);
  await provider.search({ query: ' latest release ', maxResults: 4 });
  assert.deepEqual(seen[0], { query: 'latest release', maxResults: 4, model: 'gpt-6-astra' });
  await assert.rejects(new SiwcSearchProvider(engine, async () => undefined).search({ query: 'q' }), (error: any) => error.code === 'SEARCH_MODEL_UNAVAILABLE');
});
