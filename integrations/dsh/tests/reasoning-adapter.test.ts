import test from 'node:test';
import assert from 'node:assert/strict';
import { SiwcAdapter } from '../lib/adapter.js';
import { buildRequest } from '../lib/protocol.js';
import { ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm';

const known = 'gpt-6.1-sol';
const unknown = 'fixture-unknown-model';
const options = (model = known): GenerateOptions => ({ provider: 'siwc', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture-only' }] }] });
const adapter = () => new SiwcAdapter({ status: async () => ({ activeId: 'fixture-registration' }),
  withAccessToken: operation => operation('fake-access-never-real', undefined, 'fixture-registration') });
const catalog = (models = [known, unknown]) => Response.json({ models: models.map(slug => ({ slug, display_name: slug, visibility: 'list' })) });

test('既存DSHのモデル解決に公式のeffort候補を返し、未知モデルに候補を作らない', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => { assert.equal(url, 'https://api.openai.com/v1/models'); return catalog(); });
  const client = adapter();
  assert.deepEqual((await client.listModels('siwc')).map(model => model.id), [known, unknown]);
  const resolved = await client.resolveModel('siwc', known);
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => String(effort.id)), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(resolved.reasoning?.defaultEffort, undefined);
  assert.equal((await client.resolveModel('siwc', unknown)).reasoning, undefined);
});

test('選択したeffortだけをResponsesへ変換し、未指定ではreasoningを送らない', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const request = buildRequest({ ...options(), reasoningEffort: ReasoningEffortId(effort) });
    assert.deepEqual(request.reasoning, { effort });
    assert.equal(request.reasoningEffort, undefined);
    assert.equal(request.store, false); assert.equal(request.stream, true);
  }
  assert.ok(!Object.hasOwn(buildRequest(options()), 'reasoning'));
  assert.ok(!Object.hasOwn(buildRequest(options(unknown)), 'reasoning'));
});

test('直接streamの入口でもeffortを本文へ送り、無効値はHTTP前に拒否する', async t => {
  const bodies: Record<string, unknown>[] = []; let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests++;
    if (url === 'https://api.openai.com/v1/models') return catalog();
    assert.equal(url, 'https://api.openai.com/v1/responses');
    bodies.push(JSON.parse(String(init.body)));
    const event = { type: 'response.completed', response: { status: 'completed', output: [
      { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture-only', annotations: [] }] },
    ] } };
    return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  for await (const _ of adapter().stream({ ...options(), reasoningEffort: ReasoningEffortId('low') })) {}
  assert.deepEqual(bodies[0].reasoning, { effort: 'low' });
  const before = requests;
  for (const [model, effort] of [[known, 'none'], [known, 'ultra'], [unknown, 'high'], [known, 7]]) {
    await assert.rejects(async () => { for await (const _ of adapter().stream({ ...options(String(model)), reasoningEffort: effort } as GenerateOptions)) {} }, { code: 'UNSUPPORTED_OPTION' });
  }
  assert.equal(requests, before);
});

test('推論の直前にモデル一覧を取り直さず、モデルの可否はサービスの応答で判断する', async t => {
  let catalogs = 0; let inference = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === 'https://api.openai.com/v1/models') { catalogs++; return catalog([unknown]); }
    assert.equal(url, 'https://api.openai.com/v1/responses'); inference++;
    return Response.json({ error: { code: 'model_not_found', param: 'model' } }, { status: 400 });
  });
  await assert.rejects(async () => { for await (const _ of adapter().stream({ ...options(), reasoningEffort: ReasoningEffortId('low') })) {} }, (error: any) => error.providerCode === 'model_not_found');
  assert.equal(catalogs, 0); assert.equal(inference, 1);
});
