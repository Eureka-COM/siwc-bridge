import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicationDirectory, legacyApplicationDirectory, adoptLegacyState, diskCatalogStore } from '../lib/local-cache.js';
import { dshDirectory, AuthManager } from '../lib/auth.js';
import { selectedModel } from '../lib/admin.js';
import { createWindowsTestStore } from '../lib/store.js';

const has = (file: string) => readFile(file).then(() => true, () => false);

async function withFolders(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'siwc-test-dsh-state-'));
  const previous = { profile: process.env.USERPROFILE, local: process.env.LOCALAPPDATA };
  process.env.USERPROFILE = join(root, 'profile'); process.env.LOCALAPPDATA = join(root, 'local');
  try { await run(root); }
  finally {
    if (previous.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous.profile;
    if (previous.local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous.local;
  }
}

test('every DSH file lives in the profile folder, which every launch path sees, not in %LOCALAPPDATA%', { skip: process.platform !== 'win32' }, async () => {
  await withFolders(async root => {
    assert.equal(applicationDirectory(), join(root, 'profile', '.siwc-bridge', 'apps', 'siwc-bridge-dsh'));
    assert.equal(dshDirectory(), applicationDirectory());
    assert.equal(legacyApplicationDirectory(), join(root, 'local', 'siwc-bridge-dsh'));
  });
});

test('the catalog and the default model saved by v0.3.0 and earlier move once and are read from the new folder', { skip: process.platform !== 'win32' }, async () => {
  await withFolders(async () => {
    const legacy = legacyApplicationDirectory()!;
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'model-catalog.json'), JSON.stringify({ version: 1, registrationId: 'fixture', savedAt: new Date().toISOString(), models: [{ id: 'fixture-model', name: 'Fixture model' }] }));
    await writeFile(join(legacy, 'selected-model.json'), JSON.stringify({ model: 'fixture-model', registrationId: 'fixture' }));
    assert.deepEqual(await diskCatalogStore().load('fixture'), [{ id: 'fixture-model', name: 'Fixture model' }]);
    for (const name of ['model-catalog.json', 'selected-model.json']) {
      assert.equal(await has(join(applicationDirectory(), name)), true, name);
      assert.equal(await has(join(legacy, name)), false, name);
    }
    await adoptLegacyState();
    assert.equal(JSON.parse(await readFile(join(applicationDirectory(), 'selected-model.json'), 'utf8')).model, 'fixture-model');
  });
});

test('a DPAPI sign-in saved in the earlier folder is the one DSH reads after the move', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  await withFolders(async root => {
    // The fake store is written through the isolated test store, then placed where v0.3.0 kept it.
    const staging = join(root, 'siwc-test-staging');
    await mkdir(staging, { recursive: true });
    await createWindowsTestStore(staging).transaction(async state => {
      state.registrations.push({ id: 'fixture', label: 'Fixture only', clientId: 'oaiapp_fixture', planConfirmed: true });
      state.activeId = 'fixture';
    });
    const legacy = legacyApplicationDirectory()!;
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'credentials.dpapi'), await readFile(join(staging, 'credentials.dpapi')));
    await writeFile(join(legacy, 'selected-model.json'), JSON.stringify({ model: 'fixture-model', registrationId: 'fixture' }));
    const auth = new AuthManager();
    try {
      assert.equal((await auth.status()).activeId, 'fixture');
      assert.equal(await selectedModel(auth), 'fixture-model');
    } finally { auth.abortAll(); }
    assert.equal(await has(join(applicationDirectory(), 'credentials.dpapi')), true);
    assert.equal(await has(join(legacy, 'credentials.dpapi')), false);
  });
});
