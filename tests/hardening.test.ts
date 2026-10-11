import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAuthTestHarness } from '../lib/auth.js';
import { systemPowerShell } from '../lib/store.js';
import { SiwcClient } from '../lib/client.js';
import type { AuthStore, CredentialState } from '../lib/store.js';

const NOW = 1_791_500_000_000;
const scopes = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const seed = (expiresAt: number): CredentialState => ({ version: 1, hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', activeId: 'fixture', registrations: [{
  id: 'fixture', label: 'Fixture registration', clientId: 'oaiapp_fixture', subject: 'fixture-subject', issuer: 'https://auth.openai.com', planConfirmed: true,
  credentials: { accessToken: 'fake-access-never-real', refreshToken: 'fake-refresh-never-real', scopes, expiresAt, savedAt: new Date(NOW).toISOString() } }] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('a refresh without id_token is persisted before the request, and the request runs without the exclusive lock', async () => {
  const events: string[] = [];
  let persisted: string | undefined;
  const observe = (store: AuthStore): AuthStore => ({
    ...store,
    transaction: (operation, signal, options) => store.transaction(async (state, checkpoint) => {
      events.push(options?.shared ? 'shared' : 'exclusive');
      try { return await operation(state, async () => { await checkpoint(); persisted = state.registrations[0].credentials?.refreshToken; events.push('checkpoint'); }); }
      finally { if (!options?.shared) { persisted = state.registrations[0].credentials?.refreshToken; events.push('commit'); } }
    }, signal, options),
  });
  const auth = createAuthTestHarness({ seed: seed(NOW - 1), now: () => NOW, openBrowser: async () => undefined, observeStore: observe,
    transport: async () => json({ access_token: 'fake-rotated-access', refresh_token: 'fake-rotated-refresh', token_type: 'Bearer', expires_in: 3600 }) });
  await auth.withAccessToken(async (access, _signal, registrationId) => {
    events.push('request');
    assert.equal(access, 'fake-rotated-access');
    assert.equal(registrationId, 'fixture');
    // Restart-safe: the rotated refresh token is already stored when the request starts.
    assert.equal(persisted, 'fake-rotated-refresh');
  });
  assert.ok(events.indexOf('checkpoint') < events.indexOf('request'));
  // The request itself ran inside a shared (lock-free) transaction.
  assert.equal(events[events.indexOf('request') - 1], 'shared');
});

test('PowerShell is started only from the system folder, never by bare name', async () => {
  for (const file of ['../src/store.ts', '../src/auth.ts']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.equal(/spawn\(\s*['"]powershell(\.exe)?['"]/i.test(source), false, file);
  }
  if (process.platform !== 'win32') { assert.throws(() => systemPowerShell(), { code: 'powershell_unavailable' }); return; }
  const path = systemPowerShell();
  assert.match(path, /^[A-Za-z]:\\.+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  const previous = process.env.SystemRoot;
  try {
    for (const value of ['Windows', '\\\\server\\share', '.\\fixture']) {
      process.env.SystemRoot = value;
      assert.throws(() => systemPowerShell(), { code: 'powershell_unavailable' });
    }
  } finally { process.env.SystemRoot = previous; }
});

function usageLimitResponse(): Response { return json({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'fixture' } }, 429); }
function okStream(): Response {
  const output = [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }];
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('a usage-limit stop ends when another process records a newer human start, and the local stop never re-records itself', async () => {
  const original = globalThis.fetch;
  const shared = { stopped: false, generation: 1 }; let stops = 0; let sent = 0; let limit = true;
  try {
    globalThis.fetch = async () => { sent++; return limit ? usageLimitResponse() : okStream(); };
    const credentials = { withAccessToken: async (operation: any) => operation('synthetic-test-only', undefined, 'fixture'), status: async () => ({ activeId: 'fixture' }) };
    const client = new SiwcClient(credentials, {
      beforeRequest: async () => undefined,
      onUsageLimit: async () => { stops++; shared.stopped = true; },
      usageState: async () => ({ ...shared }),
    });
    const ask = () => client.complete({ model: 'fixture', input: [{ role: 'user', content: 'fixture' }] });
    await assert.rejects(ask(), { code: 'subscription_sharing_usage_limit_exceeded' });
    assert.equal(stops, 1); assert.equal(sent, 1); assert.equal(client.isUsageLimited(), true);
    // Still stopped: refused locally, nothing sent, the shared stop is not written again.
    await assert.rejects(ask(), { code: 'USAGE_LIMIT_STOPPED' });
    assert.equal(sent, 1); assert.equal(stops, 1);
    // A resume that does not advance the generation (an old state) does not lift it.
    shared.stopped = false;
    await assert.rejects(ask(), { code: 'USAGE_LIMIT_STOPPED' });
    // Another process records a human start.
    shared.generation = 2; limit = false;
    await ask();
    assert.equal(sent, 2); assert.equal(client.isUsageLimited(), false);
  } finally { globalThis.fetch = original; }
});

test('a custom credential source without a token-bound registration still works for a new conversation', async () => {
  const original = globalThis.fetch; let sent = 0;
  try {
    globalThis.fetch = async () => { sent++; return okStream(); };
    const client = new SiwcClient({ withAccessToken: async (operation: any) => operation('synthetic-test-only'), status: async () => ({ activeId: 'fixture' }) }, { beforeRequest: async () => undefined });
    await client.complete({ model: 'fixture', input: [{ role: 'user', content: 'fixture' }] });
    assert.equal(sent, 1);
  } finally { globalThis.fetch = original; }
});

test('the browser consent of a login runs without holding the credential store transaction', async () => {
  let open = 0; let checked = false;
  const observe = (store: AuthStore): AuthStore => ({
    ...store,
    transaction: async (operation, signal, options) => {
      if (options?.shared) return store.transaction(operation, signal, options);
      open++;
      try { return await store.transaction(operation, signal, options); } finally { open--; }
    },
  });
  const auth = createAuthTestHarness({ seed: seed(NOW + 3_600_000), now: () => NOW, observeStore: observe,
    openBrowser: async () => { assert.equal(open, 0); checked = true; throw new Error('fixture stops at the browser'); },
    transport: async () => { throw new Error('No network in this fixture'); } });
  await assert.rejects(auth.login({ registrationId: 'fixture' }));
  assert.equal(checked, true);
});
