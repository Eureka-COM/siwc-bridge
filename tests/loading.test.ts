import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createMemoryTestStore, createWindowsTestStore } from '../lib/store.js';

test('shared credential transactions refuse modification and checkpoint', async () => {
  const store = createMemoryTestStore();
  await store.transaction(async state => { state.registrations.push({ id: 'fixture', label: 'Fixture', clientId: 'oaiapp_fixture', planConfirmed: false }); });
  await assert.rejects(store.transaction(async state => { state.registrations[0].planConfirmed = true; }, undefined, { shared: true }), { code: 'secure_storage_invalid' });
  await assert.rejects(store.transaction(async (_state, checkpoint) => { await checkpoint(); }, undefined, { shared: true }), { code: 'secure_storage_invalid' });
  assert.equal(await store.transaction(async state => state.registrations[0].planConfirmed, undefined, { shared: true }), false);
});

test('Windows shared reads reuse the decrypted snapshot and still see another process\'s write', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-test-shared-'));
  const store = createWindowsTestStore(directory);
  await store.transaction(async state => { state.registrations.push({ id: 'fixture', label: 'Before', clientId: 'oaiapp_fixture', planConfirmed: false }); });
  await store.transaction(async state => state.registrations[0].label, undefined, { shared: true });
  const started = Date.now();
  for (let n = 0; n < 5; n++) assert.equal(await store.transaction(async state => state.registrations[0].label, undefined, { shared: true }), 'Before');
  const warm = (Date.now() - started) / 5;
  assert.ok(warm < 60, `warm shared read took ${warm}ms`);
  const moduleURL = new URL('../lib/store.js', import.meta.url).href;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import {createWindowsTestStore} from ${JSON.stringify(moduleURL)}; await createWindowsTestStore(process.argv[1]).transaction(async s => { s.registrations[0].label = 'After'; });`, directory],
    { windowsHide: true, timeout: 30_000 });
  assert.equal(await store.transaction(async state => state.registrations[0].label, undefined, { shared: true }), 'After');
});
