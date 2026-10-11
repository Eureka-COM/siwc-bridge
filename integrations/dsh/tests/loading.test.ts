import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMemoryTestStore, createWindowsTestStore } from '../lib/store.js';
import { SiwcAdapter, CATALOG_TTL_MS, type CredentialSource } from '../lib/adapter.js';
import { diskCatalogStore, type CatalogStore } from '../lib/local-cache.js';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';

const windows = { skip: process.platform !== 'win32', timeout: 90_000 };
const registration = 'fixture-a';
const credentials = (id = registration): CredentialSource => ({
  status: async () => ({ activeId: id, registrations: [{ id, authenticated: true, planAllowed: true, planConfirmed: true }] }),
  withAccessToken: operation => operation('fake-access-never-real', undefined, id),
});
const catalog = (slugs: string[]) => Response.json({ models: slugs.map(slug => ({ slug, display_name: slug.toUpperCase(), visibility: 'list' })) });
const memoryCatalog = (seed?: { id: string; name: string }[]): CatalogStore & { saved: number } => {
  let value = seed; const store = { saved: 0,
    async load(id: string) { return id === registration ? value : undefined; },
    async save(id: string, models: readonly { id: string; name: string }[]) { if (id === registration) { value = [...models]; store.saved++; } } };
  return store;
};
const options: GenerateOptions = { provider: 'siwc', model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture-only' }] }] };
const completed = () => {
  const event = { type: 'response.completed', response: { status: 'completed', output: [
    { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture-only', annotations: [] }] }] } };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
const settle = async (rounds = 20) => { for (let n = 0; n < rounds; n++) await new Promise(resolve => setImmediate(resolve)); };

test('shared credential transactions refuse modification and checkpoint', async () => {
  const store = createMemoryTestStore();
  await store.transaction(async state => { state.registrations.push({ id: 'fixture', label: 'Fixture', clientId: 'oaiapp_fixture', planConfirmed: false }); });
  await assert.rejects(store.transaction(async state => { state.registrations[0].planConfirmed = true; }, undefined, { shared: true }), { code: 'secure_storage_invalid' });
  await assert.rejects(store.transaction(async (_state, checkpoint) => { await checkpoint(); }, undefined, { shared: true }), { code: 'secure_storage_invalid' });
  assert.equal(await store.transaction(async state => state.registrations[0].planConfirmed, undefined, { shared: true }), false);
});

test('Windows shared reads reuse the decrypted snapshot and still see another process\'s write', windows, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siwc-test-shared-'));
  const store = createWindowsTestStore(directory);
  await store.transaction(async state => { state.registrations.push({ id: 'fixture', label: 'Before', clientId: 'oaiapp_fixture', planConfirmed: false }); });
  await store.transaction(async state => state.registrations[0].label, undefined, { shared: true });
  const started = Date.now();
  for (let n = 0; n < 5; n++) assert.equal(await store.transaction(async state => state.registrations[0].label, undefined, { shared: true }), 'Before');
  const warm = (Date.now() - started) / 5;
  // Each PowerShell helper costs ~0.2s; a warm shared read must start none.
  assert.ok(warm < 60, `warm shared read took ${warm}ms`);
  const moduleURL = new URL('../lib/store.js', import.meta.url).href;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import {createWindowsTestStore} from ${JSON.stringify(moduleURL)}; await createWindowsTestStore(process.argv[1]).transaction(async s => { s.registrations[0].label = 'After'; });`, directory],
    { windowsHide: true, timeout: 30_000 });
  assert.equal(await store.transaction(async state => state.registrations[0].label, undefined, { shared: true }), 'After');
});

test('a saved catalog is served at once while one background GET refreshes it', async t => {
  let release!: (response: Response) => void; let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Promise<Response>(resolve => { release = resolve; }); });
  const store = memoryCatalog([{ id: 'fixture-model', name: 'Saved' }]);
  const adapter = new SiwcAdapter(credentials(), { catalogStore: store });
  let updates = 0; adapter.onCatalogUpdated = () => { updates++; };
  assert.deepEqual((await adapter.listModels('siwc')).map(model => [model.id, model.name]), [['fixture-model', 'Saved']]);
  assert.equal((await adapter.resolveModel('siwc', 'fixture-model')).id, 'fixture-model');
  await settle();
  assert.equal(requests, 1, 'Exactly one background refresh.');
  release(catalog(['fixture-model', 'fixture-other']));
  for (let n = 0; n < 20 && updates === 0; n++) await settle(1);
  assert.equal(updates, 1);
  assert.deepEqual((await adapter.listModels('siwc')).map(model => model.id), ['fixture-model', 'fixture-other']);
  assert.equal(store.saved, 1); assert.equal(requests, 1);
});

test('a failed background refresh keeps the saved catalog and does not notify', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'fixture_error' } }, { status: 503 }));
  const adapter = new SiwcAdapter(credentials(), { catalogStore: memoryCatalog([{ id: 'fixture-model', name: 'Saved' }]) });
  let updates = 0; adapter.onCatalogUpdated = () => { updates++; };
  await adapter.listModels('siwc'); await settle();
  assert.equal(updates, 0);
  assert.equal((await adapter.listModels('siwc'))[0].name, 'Saved');
});

test('the memory catalog is reused for ten minutes and never across registrations', async t => {
  let now = 1000; let requests = 0; let active = registration;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { requests++; return catalog(['fixture-model']); });
  const adapter = new SiwcAdapter({ status: async () => ({ activeId: active, registrations: [{ id: active, authenticated: true, planAllowed: true, planConfirmed: true }] }),
    withAccessToken: operation => operation('fake-access-never-real', undefined, active) });
  await adapter.listModels('siwc'); now += CATALOG_TTL_MS - 1;
  await adapter.resolveModel('siwc', 'fixture-model'); assert.equal(requests, 1);
  active = 'fixture-b'; await adapter.listModels('siwc'); assert.equal(requests, 2);
});

test('a signed-out registration never reuses a catalog', async t => {
  let requests = 0; let signedIn = true;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return catalog(['fixture-model']); });
  const adapter = new SiwcAdapter({ status: async () => ({ activeId: registration, registrations: [{ id: registration, authenticated: signedIn, planAllowed: signedIn, planConfirmed: true }] }),
    withAccessToken: operation => operation('fake-access-never-real', undefined, registration) });
  await adapter.listModels('siwc'); signedIn = false;
  await adapter.listModels('siwc'); assert.equal(requests, 2);
});

test('inference sends no catalog GET and a service rejection shows its HTTP status', async t => {
  let catalogs = 0; let inference = 0; let reject = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === 'https://api.openai.com/v1/models') { catalogs++; return catalog(['fixture-model']); }
    inference++;
    if (reject) return Response.json({ error: { code: 'model_not_found', param: 'model', message: 'FAKE_SECRET_ECHO' } }, { status: 400, headers: { 'x-request-id': 'req_fixture' } });
    return completed();
  });
  const adapter = new SiwcAdapter(credentials());
  for await (const _ of adapter.stream(options)) {}
  assert.equal(catalogs, 0); assert.equal(inference, 1);
  reject = true;
  await assert.rejects(async () => { for await (const _ of adapter.stream(options)) {} }, (error: any) => {
    assert.equal(error.providerCode, 'model_not_found'); assert.match(error.message, /http=400/); assert.match(error.message, /request_id=req_fixture/);
    assert.equal(error.message.includes('FAKE_SECRET_ECHO'), false); return true;
  });
  assert.equal(inference, 2, 'A 400 is not resent by the adapter itself.');
});

test('the disk catalog keeps only slugs and display names for one registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-cache-'));
  const store = diskCatalogStore(() => directory);
  await store.save(registration, [{ id: 'fixture-model', name: 'Fixture' }]);
  assert.deepEqual(await store.load(registration), [{ id: 'fixture-model', name: 'Fixture' }]);
  assert.equal(await store.load('other'), undefined);
  assert.doesNotMatch(await readFile(join(directory, 'model-catalog.json'), 'utf8'), /access|refresh|token/i);
});
