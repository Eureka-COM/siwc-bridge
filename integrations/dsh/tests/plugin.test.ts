import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { testLedger } from '../lib/ledger.js';

test('Agentを通らない公開llm/stream入口でも添付をtext投影前に拒否する', async () => {
  const events = new Map<string, Function>(); let called = 0;
  const context = { llm: { registerAdapter() {} }, effect() {}, on(name: string, callback: Function) { events.set(name, callback); }, inject() {} };
  apply(context as never);
  const middleware = events.get('llm/stream'); assert.ok(middleware);
  const next = async function* () { called++; yield { type: 'finish', reason: { kind: 'stop' } }; };
  for (const type of ['image', 'file', 'audio', 'unknown']) {
    const iterable = middleware({ provider: 'siwc', model: 'fixture-only', messages: [{ role: 'user', content: [{ type }] }] }, next);
    await assert.rejects(async () => { for await (const _ of iterable) {} }, { code: 'UNSUPPORTED_CONTENT' });
  }
  assert.equal(called, 0);
  for await (const _ of middleware({ provider: 'siwc', model: 'fixture-only', messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] }, next)) {}
  assert.equal(called, 1);
  for await (const _ of middleware({ provider: 'siwc', model: 'fixture-only', messages: [{ role: 'developer', content: [{ type: 'tool-addition', tools: [] }, { type: 'tool-removal', names: [] }] }] }, next)) {}
  assert.equal(called, 2);
});

test('slash resume requires explicit settings confirmation and preserves the stopped verification budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-dsh-command-'));
  const previousLocal = process.env.LOCALAPPDATA; const previousFetch = globalThis.fetch;
  process.env.LOCALAPPDATA = directory;
  let handler: Function | undefined; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('No network permitted in command fixture'); };
  const context = {
    llm: { registerAdapter() {} }, effect() {}, on() {},
    inject(_names: string[], callback: Function) { callback({ commands: { register(command: { handler: Function }) { handler = command.handler; } } }); },
  };
  try {
    apply(context as never); assert.ok(handler);
    const ledger = testLedger(join(directory, 'siwc-bridge-dsh', 'verification.json'));
    const invoke = (rawInput: string) => handler!({ rawInput, signal: new AbortController().signal });
    assert.equal((await invoke('resume confirmed')).kind, 'error');
    await ledger.arm(); await ledger.request('inference'); await ledger.stop();
    const guidance = await invoke('resume'); assert.equal(guidance.kind, 'success');
    assert.match(guidance.text, /再開していません/); assert.equal((await ledger.status()).armed, false);
    const confirmed = await invoke('resume confirmed'); assert.equal(confirmed.kind, 'success');
    assert.equal((await ledger.status()).armed, true); assert.equal((await ledger.status()).inference, 1);
    assert.equal((await ledger.status()).personalUse, false); assert.equal(requests, 0);
  } finally {
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
    globalThis.fetch = previousFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
