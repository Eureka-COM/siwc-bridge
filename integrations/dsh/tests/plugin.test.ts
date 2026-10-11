import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

function load() {
  const events = new Map<string, Function>(); let handler: Function | undefined; const registered: string[][] = []; const searchProviders: any[] = [];
  const context = {
    llm: { registerAdapter(providers: string[]) { registered.push(providers); return { replace() {} }; } },
    effect() {}, get() { return undefined; },
    on(name: string, callback: Function) { events.set(name, callback); },
    inject(names: string[], callback: Function) {
      if (names.includes('web')) callback({ web: { registerSearchProvider(provider: unknown) { searchProviders.push(provider); return () => undefined; } } });
      else callback({ commands: { register(command: { handler: Function }) { handler = command.handler; } } });
    },
  };
  apply(context as never);
  return { events, registered, searchProviders, invoke: (rawInput: string) => handler!({ rawInput, signal: new AbortController().signal }) };
}

test('DSH’s own web_search tool gets a ChatGPT-plan search provider instead of needing a DeepSeek key', () => {
  const { searchProviders } = load();
  assert.equal(searchProviders.length, 1);
  assert.equal(searchProviders[0].id, 'siwc');
  assert.equal(searchProviders[0].available(), true);
});

test('the plugin registers one provider and one command, and no longer refuses attachments or history at the Agent boundary', () => {
  const { events, registered } = load();
  assert.deepEqual(registered, [['siwc']]);
  for (const hook of ['agent/pre-step', 'agent/request', 'llm/stream']) assert.equal(events.has(hook), false, hook);
});

test('/siwc commands that need no sign-in respond without any network request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-dsh-command-'));
  const previous = process.env.LOCALAPPDATA, profile = process.env.USERPROFILE; process.env.LOCALAPPDATA = directory; process.env.USERPROFILE = directory;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('No network in this fixture'); });
  try {
    const { invoke } = load();
    assert.match((await invoke('manage')).text, /chatgpt\.com\/settings\/usage/);
    assert.equal((await invoke('resume')).kind, 'success');
    const unknown = await invoke('nonsense'); assert.equal(unknown.kind, 'error'); assert.match(unknown.text, /\/siwc/);
    assert.equal((await invoke('model')).kind, 'error');
    assert.equal((await invoke('select')).kind, 'error');
    assert.match((await invoke('diagnostics')).text, /診断ログ/);
    assert.equal(requests, 0);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
    if (profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = profile;
  }
});
