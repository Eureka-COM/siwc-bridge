import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { testLedger } from '../lib/ledger.js';

test('同一予算を競合要求で分割回避せず、6要求以降を送信前に拒否する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siwc-count-test-'));
  const file = join(directory, 'counts.json');
  const first = testLedger(file); const second = testLedger(file);
  await assert.rejects(first.request('inference'), { code: 'LIVE_NOT_STARTED' });
  assert.equal((await first.status()).inference, 0);
  await assert.rejects(first.finish(), { code: 'LIVE_NOT_STARTED' });
  await first.arm();
  const results = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => (i % 2 ? first : second).request('inference')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 6);
  assert.equal((await first.status()).inference, 6);
  await first.request('models'); await second.request('auth');
  assert.equal((await second.status()).models, 1);
  assert.equal((await first.status()).auth, 1);
  await first.finish();
  await second.request('inference');
  assert.equal((await first.status()).inference, 7);
  assert.equal((await first.status()).personalUse, true);
  await first.arm();
  await assert.rejects(second.request('inference'), { code: 'LIVE_BUDGET_EXHAUSTED' });
});

test('ledgerの別操作lock待機をAbortで中断し、要求件数を増やさない', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siwc-count-test-'));
  const file = join(directory, 'counts.json'); const ledger = testLedger(file);
  await ledger.arm();
  const controller = new AbortController();
  const pending = ledger.request('inference', controller.signal);
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await ledger.status()).inference, 0);
});

test('別Nodeプロセスも1つの推論6要求予算を共有する', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siwc-count-test-'));
  const file = join(directory, 'counts.json'); const ledger = testLedger(file); await ledger.arm();
  const script = `const {testLedger}=await import(${JSON.stringify(new URL('../lib/ledger.js', import.meta.url).href)}); const ledger=testLedger(process.argv[1]); let sent=0; for(let i=0;i<4;i++){try{await ledger.request('inference');sent++;}catch(e){if(e.code!=='LIVE_BUDGET_EXHAUSTED')throw e;}} process.stdout.write(String(sent));`;
  const run = () => new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', data => { stdout += String(data); });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(Number(stdout)) : reject(new Error('fixture child failed')));
  });
  const counts = await Promise.all([run(), run()]);
  assert.equal(counts.reduce((a, b) => a + b), 6); assert.equal((await ledger.status()).inference, 6);
});

test('orphaned ledger lock files allow explicit start without resetting previous counts', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siwc-count-orphan-')); const file = join(directory, 'counts.json');
  const ledger = testLedger(file); await ledger.arm(); await ledger.request('inference'); await ledger.request('models');
  const before = await ledger.status();
  await writeFile(`${file}.lock`, 'orphaned fake lock file');
  await ledger.arm();
  assert.equal((await ledger.status()).inference, before.inference); assert.equal((await ledger.status()).models, before.models);
  await ledger.request('inference'); await ledger.stop();
  assert.equal((await ledger.status()).inference, before.inference + 1);
  assert.equal((await ledger.status()).armed, false);
  await assert.rejects(ledger.request('inference'), { code: 'LIVE_NOT_STARTED' });
});

test('Windows ledger lock waits abort safely and a killed holder releases the OS lock', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siwc-count-killed-')); const file = join(directory, 'counts.json');
  const ledger = testLedger(file); await ledger.arm(); await ledger.request('inference');
  const script = `const {withWindowsFileLock}=await import(${JSON.stringify(new URL('../lib/store.js', import.meta.url).href)}); await withWindowsFileLock(process.argv[1],async()=>{console.log('LOCKED');await new Promise(resolve=>process.stdin.once('data',resolve));});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, `${file}.lock`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('close', () => reject(new Error('Fake ledger lock holder exited before locking')));
    child.stdout.on('data', data => { if (String(data).includes('LOCKED')) resolve(); });
  });
  try {
    await ready;
    const controller = new AbortController(); let settled = false;
    const pending = ledger.request('inference', controller.signal).finally(() => { settled = true; });
    const checked = assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 800)); assert.equal(settled, false);
    controller.abort(); await checked;
    assert.equal((await ledger.status()).inference, 1);
    child.kill(); await closed;
    await ledger.arm(); await ledger.request('inference'); assert.equal((await ledger.status()).inference, 2);
  } finally { child.kill(); await closed; }
});

test('human-confirmed resume restores a stopped personal mode across restart and preserves its cumulative counts', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siwc-count-resume-')); const file = join(directory, 'counts.json');
  const ledger = testLedger(file); await ledger.arm();
  for (let index = 0; index < 6; index++) await ledger.request('inference');
  await ledger.finish(); await ledger.request('inference');
  await ledger.stop(); await ledger.stop();
  const restarted = testLedger(file), stopped = await restarted.status();
  assert.equal(stopped.inference, 7); assert.equal(stopped.stoppedFrom, 'personal');
  await assert.rejects(restarted.request('inference'), { code: 'LIVE_NOT_STARTED' });
  await assert.rejects(restarted.resume({ settingsConfirmed: false }), { code: 'SETTINGS_NOT_CONFIRMED' });
  assert.deepEqual(await restarted.status(), stopped);
  await restarted.resume({ settingsConfirmed: true });
  assert.equal((await restarted.status()).inference, 7); assert.equal((await restarted.status()).personalUse, true);
  assert.equal((await restarted.status()).armed, false); assert.equal((await restarted.status()).stoppedFrom, undefined);
  await restarted.request('inference'); assert.equal((await restarted.status()).inference, 8);
});

test('verification resume preserves its six-request cap and cannot enable an unstarted ledger', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siwc-count-resume-')); const file = join(directory, 'counts.json');
  const ledger = testLedger(file);
  await assert.rejects(ledger.resume({ settingsConfirmed: true }), { code: 'LIVE_NOT_STARTED' });
  await ledger.stop(); await assert.rejects(ledger.resume({ settingsConfirmed: true }), { code: 'LIVE_NOT_STARTED' });
  await ledger.arm(); for (let index = 0; index < 5; index++) await ledger.request('inference');
  await ledger.stop(); await ledger.stop();
  const restarted = testLedger(file); assert.equal((await restarted.status()).stoppedFrom, 'verification');
  await assert.rejects(restarted.resume({ settingsConfirmed: false }), { code: 'SETTINGS_NOT_CONFIRMED' });
  await restarted.resume({ settingsConfirmed: true });
  assert.equal((await restarted.status()).armed, true); assert.equal((await restarted.status()).personalUse, false);
  await restarted.request('inference');
  await assert.rejects(restarted.request('inference'), { code: 'LIVE_BUDGET_EXHAUSTED' });
  assert.equal((await restarted.status()).inference, 6);
  await restarted.stop();
  const exhausted = await restarted.status();
  assert.equal(exhausted.armed, false); assert.equal(exhausted.stoppedFrom, 'verification');
  await assert.rejects(restarted.resume({ settingsConfirmed: true }), { code: 'LIVE_BUDGET_EXHAUSTED' });
  assert.deepEqual(await restarted.status(), exhausted);
  await ledger.stop(); await ledger.arm(); assert.equal((await ledger.status()).stoppedFrom, undefined);
  await ledger.finish(); assert.equal((await ledger.status()).stoppedFrom, undefined);
});

test('explicit finish can end stopped verification but cannot bypass an unstarted or personal stop', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-siwc-count-finish-')); const file = join(directory, 'counts.json');
  const ledger = testLedger(file);
  const initial = await ledger.status();
  await assert.rejects(ledger.finish(), { code: 'LIVE_NOT_STARTED' });
  const unstarted = await ledger.status();
  assert.equal(unstarted.inference, initial.inference); assert.equal(unstarted.armed, false); assert.equal(unstarted.personalUse, false);
  await ledger.arm(); for (let index = 0; index < 6; index++) await ledger.request('inference');
  await ledger.stop();
  const restarted = testLedger(file), stopped = await restarted.status();
  await assert.rejects(restarted.resume({ settingsConfirmed: true }), { code: 'LIVE_BUDGET_EXHAUSTED' });
  assert.deepEqual(await restarted.status(), stopped);
  await restarted.finish();
  const finished = await restarted.status();
  assert.equal(finished.inference, 6); assert.equal(finished.personalUse, true); assert.equal(finished.armed, false);
  assert.equal(finished.stoppedFrom, undefined);
  await restarted.request('inference'); assert.equal((await restarted.status()).inference, 7);
  await restarted.stop();
  const personalStopped = await restarted.status(); assert.equal(personalStopped.stoppedFrom, 'personal');
  await assert.rejects(restarted.finish(), { code: 'LIVE_NOT_STARTED' });
  assert.deepEqual(await restarted.status(), personalStopped);
});

test('the first-use confirmation starts personal use but never lifts a usage-limit stop or a running verification', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-ledger-start-'));
  const ledger = testLedger(join(directory, 'counts.json'));
  await assert.rejects(ledger.request('inference'), (error: any) => error.code === 'LIVE_NOT_STARTED' && /confirm/.test(error.message));
  assert.equal(await ledger.start(), 'started');
  await ledger.request('inference');
  assert.equal(await ledger.start(), 'already');
  assert.equal((await ledger.status()).inference, 1);
  await ledger.stop();
  await assert.rejects(ledger.request('inference'), (error: any) => error.code === 'LIVE_NOT_STARTED' && /resume/.test(error.message));
  assert.equal(await ledger.start(), 'stopped');
  assert.equal((await ledger.status()).personalUse, false, 'A stop is not lifted by confirm.');
  await ledger.resume({ settingsConfirmed: true });
  await ledger.request('inference');
  assert.equal((await ledger.status()).inference, 2, 'Counts are never reset.');
  const armed = testLedger(join(directory, 'armed.json')); await armed.arm();
  assert.equal(await armed.start(), 'verification');
  assert.equal((await armed.status()).armed, true);
});
