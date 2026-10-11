import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudgetTestHarness } from '../lib/budget.js';
import { spawn } from 'node:child_process';

test('grant is explicit, shared and bounded under concurrent requests including failures', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'siwc-sdk-budget-')); const file = join(folder, 'requests.json');
  const first = createBudgetTestHarness(file); const second = createBudgetTestHarness(file);
  await assert.rejects(first.request('inference'), { code: 'INFERENCE_NOT_STARTED' });
  await assert.rejects(first.begin({ maxRequests: 2, creditSettingsConfirmed: false }), { code: 'SETTINGS_NOT_CONFIRMED' });
  await first.begin({ maxRequests: 2, creditSettingsConfirmed: true });
  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => (index % 2 ? first : second).request('inference')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal((await first.status()).inference, 2);
  await second.stop(); await assert.rejects(first.request('inference'), { code: 'INFERENCE_NOT_STARTED' });
  await first.begin({ maxRequests: 1, creditSettingsConfirmed: true }); await second.request('inference');
  assert.equal((await first.status()).inference, 3); assert.equal((await first.status()).allowedThrough, 3);
});
test('corruption and interrupted lock wait cannot reset or add a request', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'siwc-sdk-budget-')); const file = join(folder, 'requests.json');
  const budget = createBudgetTestHarness(file); await writeFile(file, '{"invalid":true}');
  await assert.rejects(budget.begin({ maxRequests: 6, creditSettingsConfirmed: true }), { code: 'BUDGET_INVALID' });
  const other = join(folder, 'second.json'); const second = createBudgetTestHarness(other);
  await second.begin({ maxRequests: 1, creditSettingsConfirmed: true });
  const abort = new AbortController(); const pending = second.request('inference', abort.signal); abort.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal((await second.status()).inference, 0);
});

test('orphaned budget lock files allow a new grant without resetting previous counts', { timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'siwc-sdk-budget-orphan-')); const file = join(folder, 'requests.json');
  const budget = createBudgetTestHarness(file);
  await budget.begin({ maxRequests: 3, creditSettingsConfirmed: true });
  await budget.request('inference'); await budget.request('models');
  const before = await budget.status();
  await writeFile(`${file}.lock`, 'orphaned fake lock file');
  const next = await budget.begin({ maxRequests: 2, creditSettingsConfirmed: true });
  assert.equal(next.inference, before.inference); assert.equal(next.models, before.models);
  assert.equal(next.allowedThrough, before.inference + 2);
  await budget.request('inference'); await budget.stop();
  assert.equal((await budget.status()).inference, before.inference + 1);
  assert.equal((await budget.status()).enabled, false);
});

test('Windows budget lock waits abort safely and a killed holder releases the OS lock', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'siwc-sdk-budget-killed-')); const file = join(folder, 'requests.json');
  const budget = createBudgetTestHarness(file); await budget.begin({ maxRequests: 3, creditSettingsConfirmed: true }); await budget.request('inference');
  const script = `const {withWindowsFileLock}=await import(${JSON.stringify(new URL('../lib/store.js', import.meta.url).href)}); await withWindowsFileLock(process.argv[1],async()=>{console.log('LOCKED');await new Promise(resolve=>process.stdin.once('data',resolve));});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, `${file}.lock`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject); child.once('close', () => reject(new Error('Fake budget lock holder exited before locking')));
    child.stdout.on('data', data => { if (String(data).includes('LOCKED')) resolve(); });
  });
  try {
    await ready;
    const controller = new AbortController(); let settled = false;
    const pending = budget.request('inference', controller.signal).finally(() => { settled = true; });
    const checked = assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 800)); assert.equal(settled, false);
    controller.abort(); await checked;
    assert.equal((await budget.status()).inference, 1);
    child.kill(); await closed;
    const next = await budget.begin({ maxRequests: 2, creditSettingsConfirmed: true });
    assert.equal(next.inference, 1); assert.equal(next.allowedThrough, 3);
    await budget.request('inference'); assert.equal((await budget.status()).inference, 2);
  } finally { child.kill(); await closed; }
});
