import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { adoptLegacyFile, createMemoryTestStore, createWindowsTestStore, systemPowerShell, WindowsStore } from '../lib/store.js';
import { appDirectory, legacyAppDirectory, validateAppIdentity } from '../lib/app.js';
import { RequestBudget } from '../lib/budget.js';

test('application identity accepts display names but rejects paths, Windows reserved IDs, and control characters', () => {
  assert.deepEqual(validateAppIdentity({ appId: 'fixture-tool', appName: 'Fixture Local Tool' }), { appId: 'fixture-tool', appName: 'Fixture Local Tool' });
  const slash = String.fromCharCode(92);
  const absolute = join(tmpdir(), 'invalid-app-id');
  const unc = slash.repeat(2) + ['example-host', 'private-share'].join(slash);
  for (const appId of ['', '../escape', absolute, unc, 'UpperCase', 'app.name', 'con', 'aux', 'nul', 'com1', 'lpt9', 'x'.repeat(65)]) {
    assert.throws(() => validateAppIdentity({ appId, appName: 'Fixture' }), { code: 'app_identity_invalid' });
    assert.throws(() => appDirectory(appId), { code: 'app_identity_invalid' });
  }
  for (const appName of ['', '  ', 'Fixture\nTool', 'Fixture\u007fTool', 'x'.repeat(101)]) assert.throws(() => validateAppIdentity({ appId: 'fixture-tool', appName }), { code: 'app_identity_invalid' });
  if (process.platform === 'win32') {
    const first = appDirectory('fixture-one');
    const second = appDirectory('fixture-two');
    assert.equal(first, join(process.env.USERPROFILE!, '.siwc-bridge', 'apps', 'fixture-one'));
    assert.equal(first === second, false);
    assert.equal(first.includes('dsh-siwc-bridge'), false);
    // %LOCALAPPDATA% is private per packaged (MSIX) parent app, so it is only a source to move from.
    assert.equal(legacyAppDirectory('fixture-one'), join(process.env.LOCALAPPDATA!, 'siwc-bridge', 'apps', 'fixture-one'));
  }
});

async function folders(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const legacy = join(root, 'legacy'), current = join(root, 'current');
  await mkdir(legacy, { recursive: true });
  return { root, legacy, current };
}
const has = (file: string) => readFile(file).then(() => true, () => false);

test('a file of the same app moves once from its earlier folder, and concurrent callers share that move', async () => {
  const { legacy, current } = await folders('siwc-adopt-move-');
  await writeFile(join(legacy, 'credentials.dpapi'), 'encrypted-fixture');
  const calls = await Promise.all([1, 2, 3].map(() => adoptLegacyFile(current, legacy, 'credentials.dpapi')));
  assert.equal(calls.length, 3);
  assert.equal(await readFile(join(current, 'credentials.dpapi'), 'utf8'), 'encrypted-fixture');
  assert.equal(await has(join(legacy, 'credentials.dpapi')), false, 'no stale copy is left behind');
  assert.deepEqual((await readdir(current)).filter(name => name.endsWith('.tmp')), []);
});

test('a file already in the new folder is never replaced, and the earlier copy is then left alone', async () => {
  const { legacy, current } = await folders('siwc-adopt-newer-');
  await mkdir(current, { recursive: true });
  await writeFile(join(current, 'credentials.dpapi'), 'newer-sign-in');
  await writeFile(join(legacy, 'credentials.dpapi'), 'older-sign-in');
  await adoptLegacyFile(current, legacy, 'credentials.dpapi');
  assert.equal(await readFile(join(current, 'credentials.dpapi'), 'utf8'), 'newer-sign-in');
  assert.equal(await readFile(join(legacy, 'credentials.dpapi'), 'utf8'), 'older-sign-in');
});

test('no earlier folder, no earlier file, or the same folder: nothing is created', async () => {
  const { legacy, current } = await folders('siwc-adopt-none-');
  await adoptLegacyFile(current, undefined, 'credentials.dpapi');
  await adoptLegacyFile(current, legacy, 'credentials.dpapi');
  await writeFile(join(legacy, 'requests.json'), '{}');
  await adoptLegacyFile(legacy, legacy, 'requests.json');
  assert.equal(await has(join(current, 'credentials.dpapi')), false);
  assert.equal(await readFile(join(legacy, 'requests.json'), 'utf8'), '{}');
});

test('a link in the earlier folder is never followed', async t => {
  const { root, legacy, current } = await folders('siwc-adopt-link-');
  await writeFile(join(root, 'elsewhere'), 'not-this-app');
  try { await symlink(join(root, 'elsewhere'), join(legacy, 'credentials.dpapi')); }
  catch { t.skip('This account cannot create symbolic links'); return; }
  await adoptLegacyFile(current, legacy, 'credentials.dpapi');
  assert.equal(await has(join(current, 'credentials.dpapi')), false);
});

test('Windows: a DPAPI sign-in and a quota stop written in the earlier folder are read from the profile folder after the move', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'siwc-test-move-'));
  const legacy = join(root, 'legacy-store'), current = join(root, 'current-store');
  await mkdir(legacy, { recursive: true });
  await createWindowsTestStore(legacy).transaction(async state => {
    state.registrations.push({ id: 'fixture', label: 'Fixture only', clientId: 'oaiapp_fixture', planConfirmed: true });
    state.activeId = 'fixture';
  });
  const moved = new WindowsStore('fixture-move', current, legacy);
  assert.equal(await moved.transaction(async state => state.activeId, undefined, { shared: true }), 'fixture');
  assert.equal(await has(join(legacy, 'credentials.dpapi')), false);

  const previous = { profile: process.env.USERPROFILE, local: process.env.LOCALAPPDATA };
  try {
    process.env.USERPROFILE = join(root, 'profile'); process.env.LOCALAPPDATA = join(root, 'local');
    const old = legacyAppDirectory('fixture-quota')!;
    await mkdir(old, { recursive: true });
    await writeFile(join(old, 'requests.json'), JSON.stringify({ version: 1, enabled: false, auth: 1, models: 2, inference: 5, allowedThrough: 5, generation: 3 }));
    const status = await new RequestBudget('fixture-quota').status();
    assert.equal(status.enabled, false); assert.equal(status.inference, 5); assert.equal(status.generation, 3);
    assert.equal(await has(join(appDirectory('fixture-quota'), 'requests.json')), true);
  } finally {
    if (previous.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous.profile;
    if (previous.local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous.local;
  }
});

test('memory test store has stable host identity and separate serialized registrations', async () => {
  const store = createMemoryTestStore();
  const host = await store.transaction(async state => state.hostId);
  await Promise.all([1, 2].map(n => store.transaction(async state => { state.registrations.push({ id: `fixture-${n}`, label: `Fixture ${n}`, clientId: `oaiapp_fixture_${n}`, planConfirmed: false }); })));
  await store.transaction(async state => { assert.equal(state.hostId, host); assert.equal(state.registrations.length, 2); });
  assert.throws(() => createWindowsTestStore(join(process.env.LOCALAPPDATA ?? dirname(tmpdir()), 'siwc-bridge')));
});

test('a queued transaction settles promptly on abort without executing or overtaking the queue', async () => {
  const store = createMemoryTestStore();
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const holding = store.transaction(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await began;
  const controller = new AbortController();
  let executed = 0;
  const queued = store.transaction(async () => { executed++; }, controller.signal).then(() => 'fulfilled', error => (error as { code: string }).code);
  controller.abort();
  try { assert.equal(await Promise.race([queued, new Promise(resolve => setTimeout(() => resolve('timed_out'), 200))]), 'cancelled'); }
  finally { release(); await holding; await queued; }
  await store.transaction(async () => undefined);
  assert.equal(executed, 0);
});

test('a closed Windows request scope ignores an already pending generation poll', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-test-closed-scope-'));
  const store = createWindowsTestStore(directory);
  const scope = await store.openRequestScope();
  const original = fs.promises.readFile;
  let intercepted = false;
  let entered: () => void = () => undefined, release: () => void = () => undefined, settled: () => void = () => undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { settled = resolve; });
  fs.promises.readFile = (async (...args: Parameters<typeof original>) => {
    if (String(args[0]) === join(directory, 'request-generation') && !intercepted) {
      intercepted = true; entered(); await gate;
      const result = await original(...args); settled(); return result;
    }
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await started;
    scope.close();
    await store.cancelRequests();
    release();
    await finished;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(scope.signal.aborted, false);
  } finally {
    release(); scope.close(); fs.promises.readFile = original; syncBuiltinESMExports();
  }
});

test('Windows CurrentUser DPAPI, atomic persistence, restart, and OS exclusive lock use only fake credentials', { skip: process.platform !== 'win32', timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-test-'));
  const first = createWindowsTestStore(directory);
  const host = await first.transaction(async state => {
    state.registrations.push({ id: 'fixture', label: 'Fixture only', clientId: 'oaiapp_fixture', subject: 'fixture-subject', issuer: 'https://auth.openai.com', planConfirmed: false, credentials: { accessToken: ['FAKE', 'DPAPI', 'ACCESS', 'NEVER', 'REAL'].join('_'), refreshToken: ['FAKE', 'DPAPI', 'REFRESH', 'NEVER', 'REAL'].join('_'), idToken: ['FAKE', 'DPAPI', 'ID', 'NEVER', 'REAL'].join('_'), scopes: ['openid'], expiresAt: Date.now() + 1000, savedAt: new Date().toISOString() } });
    return state.hostId;
  });
  const encrypted = await readFile(join(directory, 'credentials.dpapi'));
  assert.equal(encrypted.includes(Buffer.from('FAKE_DPAPI_')), false);
  const restarted = createWindowsTestStore(directory);
  await restarted.transaction(async state => { assert.equal(state.hostId, host); assert.equal(state.registrations[0].credentials?.refreshToken, 'FAKE_DPAPI_REFRESH_NEVER_REAL'); });
  let active = 0; let peak = 0;
  await Promise.all([first, restarted].map(store => store.transaction(async state => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 40)); state.registrations[0].planConfirmed = true; active--; })));
  assert.equal(peak, 1);
  const moduleURL = new URL('../lib/store.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createWindowsTestStore} from ${JSON.stringify(moduleURL)}; await createWindowsTestStore(process.argv[1]).transaction(async () => { console.log('LOCKED'); await new Promise(resolve => setTimeout(resolve, 900)); });`, directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const completed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Isolated fake-store process failed'))); });
  await new Promise<void>((resolve, reject) => { child.stdout.on('data', data => { if (String(data).includes('LOCKED')) resolve(); }); child.once('exit', code => { if (code !== 0) reject(new Error('Isolated fake-store lock not acquired')); }); });
  const waitStart = Date.now();
  await first.transaction(async () => { assert.ok(Date.now() - waitStart >= 500, 'The other process must release its OS lock before entering'); });
  await completed;
  const acl = await promisify(execFile)(systemPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', '$a=[IO.Directory]::GetAccessControl($env:SIWC_FAKE_STORE); $s=[Security.Principal.WindowsIdentity]::GetCurrent().User; $valid=$a.AreAccessRulesProtected -and ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $s.Value); foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if($r.IdentityReference.Value -ne $s.Value) { $valid=$false } }; [Console]::Out.WriteLine($valid)'], { windowsHide: true, env: { ...process.env, SIWC_FAKE_STORE: directory } });
  assert.equal(acl.stdout.trim(), 'True');
  const request = await first.openRequestScope();
  try {
    await request.check();
    await restarted.cancelRequests();
    await assert.rejects(request.check(), { code: 'cancelled' });
  } finally { request.close(); }
  const corrupted = await restarted.openRequestScope();
  try {
    await writeFile(join(directory, 'request-generation'), 'invalid-generated-fixture-marker');
    await assert.rejects(corrupted.check(), { code: 'cancelled' });
  } finally { corrupted.close(); }
  await restarted.cancelRequests();
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
  // Leave only encrypted fake state as local evidence; no plaintext file is created.
});
