import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createAuthTestHarness } from '../lib/auth.js';
import type { CredentialState } from '../lib/store.js';
import { createWindowsTestStore } from '../lib/store.js';

const NOW = 1_791_500_000_000;
const CLIENT = 'oaiapp_fixture';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey); jwk.kid = 'fixture'; jwk.alg = 'RS256';
const discovery = { issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' };
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
async function token(options: { nonce?: string; subject?: string; aud?: string; expired?: boolean; wrongSignature?: boolean }): Promise<string> {
  const key = options.wrongSignature ? (await generateKeyPair('RS256')).privateKey : privateKey;
  return new SignJWT({ nonce: options.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer('https://auth.openai.com').setSubject(options.subject ?? 'fixture-subject').setAudience(options.aud ?? CLIENT).setIssuedAt(Math.floor(NOW / 1000)).setExpirationTime(Math.floor(NOW / 1000) + (options.expired ? -1 : 3600)).sign(key);
}
function seed(options: { allowed?: boolean; confirmed?: boolean; expiresAt?: number } = {}): CredentialState {
  return { version: 1, hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', activeId: 'fixture', registrations: [{ id: 'fixture', label: 'Fixture registration', clientId: CLIENT, subject: 'fixture-subject', issuer: 'https://auth.openai.com', planConfirmed: options.confirmed ?? true, credentials: { accessToken: 'fake-access-never-real', refreshToken: 'fake-refresh-never-real', scopes: (options.allowed === false ? 'openid profile email offline_access' : scopes).split(' '), expiresAt: options.expiresAt ?? NOW + 3_600_000, savedAt: new Date(NOW).toISOString() } }] };
}
interface Scenario { appName?: string; callback?: 'state' | 'client' | 'denied' | 'duplicate' | 'replay'; nonce?: 'wrong'; subject?: string; aud?: string; expired?: boolean; wrongSignature?: boolean; grantedScope?: string; identityOnly?: boolean; tokenFailure?: string; seed?: CredentialState; testDirectory?: string; reply?: (url: string, response: Response) => Response; }
function loginHarness(scenario: Scenario = {}) {
  let nonce = ''; let authURL: URL | undefined; const calls: { url: string; init: RequestInit }[] = [];
  const auth = createAuthTestHarness({ appName: scenario.appName, seed: scenario.seed, testDirectory: scenario.testDirectory, now: () => NOW, openBrowser: async raw => {
    authURL = new URL(raw); nonce = authURL.searchParams.get('nonce')!;
    const callback = new URL(authURL.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: authURL.searchParams.get('state')!, code: 'fake-one-time-code', client_id: scenario.callback === 'client' ? 'oaiapp_other' : CLIENT }).toString();
    if (scenario.callback === 'state') {
      const wrong = new URL(callback); wrong.searchParams.set('state', 'mismatch');
      const duplicate = new URL(callback); duplicate.searchParams.append('state', 'extra');
      const missing = new URL(callback); missing.searchParams.delete('state');
      for (const stray of [wrong, duplicate, missing]) {
        assert.equal((await fetch(stray, { redirect: 'error' })).status, 400);
        assert.equal(calls.length, 0);
      }
    }
    if (scenario.callback === 'denied') callback.searchParams.set('error', 'access_denied');
    if (scenario.callback === 'duplicate') callback.searchParams.append('code', 'extra');
    await fetch(callback, { redirect: 'error' });
    if (scenario.callback === 'replay') assert.equal((await fetch(callback, { redirect: 'error' })).status, 400);
  }, transport: async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, 'https://auth.openai.com');
    assert.equal(init.redirect, 'error');
    const reply = (response: Response) => scenario.reply?.(url, response) ?? response;
    if (url.endsWith('/.well-known/openid-configuration')) return reply(json(discovery));
    if (url.endsWith('/.well-known/jwks.json')) return reply(json({ keys: [jwk] }));
    if (url.endsWith('/oauth/token')) {
      if (scenario.tokenFailure) return reply(json({ error: scenario.tokenFailure }, 400));
      return reply(json({ ...(scenario.identityOnly ? {} : { access_token: 'fake-access-never-real', refresh_token: 'fake-refresh-never-real', token_type: 'Bearer', expires_in: 3600 }), id_token: await token({ nonce: scenario.nonce === 'wrong' ? 'bad-nonce' : nonce, subject: scenario.subject, aud: scenario.aud, expired: scenario.expired, wrongSignature: scenario.wrongSignature }), scope: scenario.grantedScope ?? scopes }));
    }
    throw new Error('Unexpected fixed endpoint');
  } });
  return { auth, calls, url: () => authURL! };
}

function largeAuthResponse() {
  let bytes = 0, cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (bytes >= 3 * 1024 * 1024) { controller.close(); return; }
    const chunk = new Uint8Array(64 * 1024).fill(32); bytes += chunk.byteLength; controller.enqueue(chunk);
  }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  return { response: new Response(body), stats: () => ({ bytes, cancelled, locked: body.locked }) };
}

test('discovery, JWKS and OAuth code JSON stop reading at the byte cap without accepting credentials', async () => {
  for (const endpoint of ['openid-configuration', 'jwks.json', 'oauth/token']) {
    const large = largeAuthResponse();
    const { auth } = loginHarness({ reply: (url, response) => url.endsWith(endpoint) ? large.response : response });
    await assert.rejects(auth.login(), { code: 'RESPONSE_TOO_LARGE' });
    assert.ok(large.stats().bytes <= 1024 * 1024 + 64 * 1024);
    assert.equal(large.stats().cancelled, 1); assert.equal(large.stats().locked, false);
    assert.equal((await auth.status()).registrations.some(row => row.authenticated), false);
  }
});

test('oversized refresh retains credentials; oversized revocation still signs out locally', async () => {
  const large = largeAuthResponse(); let called = false;
  const { auth } = loginHarness({ seed: seed({ expiresAt: NOW - 1 }), reply: (url, response) => url.endsWith('oauth/token') ? large.response : response });
  await assert.rejects(auth.withAccessToken(async () => { called = true; }), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(called, false); assert.equal((await auth.status()).registrations[0].authenticated, true);
  assert.equal(large.stats().cancelled, 1); assert.equal(large.stats().locked, false);
  const revocations: ReturnType<typeof largeAuthResponse>[] = [];
  const signingOut = createAuthTestHarness({ seed: seed(), now: () => NOW, openBrowser: async () => {}, transport: async url => {
    if (url.endsWith('openid-configuration')) return json(discovery);
    const body = largeAuthResponse(); revocations.push(body); return body.response;
  } });
  assert.equal((await signingOut.signOut()).remoteRevocation, 'unconfirmed');
  assert.equal((await signingOut.status()).registrations[0].authenticated, false);
  for (const body of revocations) { assert.ok(body.stats().bytes <= 1024 * 1024 + 64 * 1024); assert.equal(body.stats().cancelled, 1); assert.equal(body.stats().locked, false); }
});

test('blocked authentication JSON aborts promptly and retains saved credentials', async () => {
  let entered!: () => void, cancelled = 0; const waiting = new Promise<void>(resolve => { entered = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { entered(); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const signal = new AbortController();
  const auth = createAuthTestHarness({ seed: seed({ expiresAt: NOW - 1 }), now: () => NOW, openBrowser: async () => {}, transport: async () => new Response(body) });
  const pending = auth.withAccessToken(async () => {}, signal.signal);
  await waiting; signal.abort(); await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(cancelled, 1); assert.equal(body.locked, false); assert.equal((await auth.status()).registrations[0].authenticated, true);
});

test('new dynamic registration binds PKCE/redirect/client/identity and returns sanitized state', async () => {
  const harness = loginHarness({ callback: 'replay', appName: 'Fixture Local Tool' });
  const state = await harness.auth.login();
  assert.equal(state.registrations[0].authenticated, true);
  assert.equal(state.registrations[0].planAllowed, true);
  assert.equal(state.registrations[0].planConfirmed, false);
  assert.equal(harness.url().searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(harness.url().searchParams.get('agent_name_hint'), 'Fixture Local Tool');
  assert.match(harness.url().searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  const exchange = new URLSearchParams(String(harness.calls.find(call => call.url.endsWith('/oauth/token'))!.init.body));
  assert.equal(exchange.get('client_id'), CLIENT);
  assert.equal(exchange.get('redirect_uri'), harness.url().searchParams.get('redirect_uri'));
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'), harness.url().searchParams.get('code_challenge'));
  assert.equal(JSON.stringify(state).includes('fake-access'), false);
  await assert.rejects(harness.auth.withAccessToken(async () => undefined), { code: 'plan_confirmation_required' });
  await harness.auth.confirmPlan();
  assert.equal((await harness.auth.status()).hostId, state.hostId);
});

test('stray loopback state requests cannot consume a login or prevent its one valid code exchange', async () => {
  const harness = loginHarness({ callback: 'state' });
  const status = await harness.auth.login();
  assert.equal(status.registrations[0].authenticated, true);
  assert.equal(harness.calls.filter(call => call.url.endsWith('/oauth/token')).length, 1);
});

test('callback and cryptographic identity failures never overwrite a selected registration', async () => {
  const scenarios: [Scenario, string][] = [[{ callback: 'client' }, 'oauth_client_mismatch'], [{ callback: 'denied' }, 'oauth_access_denied'], [{ callback: 'duplicate' }, 'oauth_callback_invalid'], [{ nonce: 'wrong' }, 'id_token_invalid'], [{ aud: 'oaiapp_other' }, 'id_token_invalid'], [{ subject: 'other-person' }, 'id_token_invalid'], [{ expired: true }, 'id_token_invalid'], [{ wrongSignature: true }, 'id_token_invalid']];
  for (const [scenario, code] of scenarios) {
    const harness = loginHarness({ ...scenario, seed: seed() });
    await assert.rejects(harness.auth.login({ registrationId: 'fixture' }), { code });
    const state = await harness.auth.status();
    assert.equal(state.activeId, 'fixture');
    assert.equal(state.registrations.length, 1);
    assert.equal(state.registrations[0].authenticated, true);
    if (scenario.callback) assert.equal(harness.calls.length, 0);
  }
});

test('authentication without ChatGPT permission results in zero inference operations', async () => {
  for (const identityOnly of [false, true]) {
    const harness = loginHarness({ identityOnly, grantedScope: identityOnly ? 'openid profile email' : 'openid profile email offline_access' });
    const status = await harness.auth.login();
    assert.equal(status.registrations[0].authenticated, true);
    assert.equal(status.registrations[0].planAllowed, false);
    let operations = 0;
    await assert.rejects(harness.auth.withAccessToken(async () => { operations++; }), { code: 'plan_permission_required' });
    assert.equal(operations, 0);
  }
});

test('an issued dynamic registration survives a failed one-time code exchange', async () => {
  const harness = loginHarness({ tokenFailure: 'invalid_grant' });
  await assert.rejects(harness.auth.login(), { code: 'oauth_code_expired' });
  const state = await harness.auth.status();
  assert.equal(state.registrations.length, 1);
  assert.equal(state.registrations[0].authenticated, false);
  assert.equal(state.activeId, undefined);
  await assert.rejects(harness.auth.login({ registrationId: state.registrations[0].id }), { code: 'oauth_code_expired' });
  assert.equal(harness.url().searchParams.get('client_id'), CLIENT);
  assert.equal(harness.url().searchParams.has('agent_name_hint'), false);
  assert.equal((await harness.auth.status()).registrations.length, 1);
});

test('temporary refresh failure retains credentials; terminal error clears only credentials', async () => {
  for (const [error, status, expected] of [['server_error', 503, true], ['invalid_grant', 400, false]] as const) {
    const auth = createAuthTestHarness({ seed: seed({ expiresAt: NOW - 1 }), now: () => NOW, openBrowser: async () => { throw new Error('No browser'); }, transport: async () => json({ error, error_description: 'fake-secret-never-show' }, status) });
    await assert.rejects(auth.withAccessToken(async () => undefined));
    const state = await auth.status();
    assert.equal(state.registrations[0].authenticated, expected);
    assert.equal(state.registrations.length, 1);
    assert.equal(state.hostId, seed().hostId);
  }
});

test('status distinguishes expired nonrenewable credentials from an expired renewable grant', async () => {
  for (const renewable of [false, true]) {
    const fixture = seed({ expiresAt: NOW + 1000 });
    if (!renewable) {
      delete fixture.registrations[0].credentials!.refreshToken;
      fixture.registrations[0].credentials!.scopes = scopes.split(' ').filter(scope => scope !== 'offline_access');
    }
    let clock = NOW;
    let requests = 0;
    const auth = createAuthTestHarness({ seed: fixture, now: () => clock, openBrowser: async () => undefined, transport: async () => { requests++; return json({ error: 'server_error' }, 503); } });
    assert.equal((await auth.status()).registrations[0].authenticated, true);
    clock += 1001;
    const expired = (await auth.status()).registrations[0];
    assert.equal(expired.authenticated, renewable);
    assert.equal(expired.planAllowed, renewable);
    if (!renewable) {
      await assert.rejects(auth.withAccessToken(async () => undefined), { code: 'sign_in_required' });
      assert.equal(requests, 0);
      assert.equal((await auth.status()).registrations.length, 1);
    }
  }
});

test('concurrent operations serialize one rotating refresh and abortAll reaches operation signal', async () => {
  let refreshes = 0;
  const auth = createAuthTestHarness({ seed: seed({ expiresAt: NOW - 1 }), now: () => NOW, openBrowser: async () => undefined, transport: async () => { refreshes++; await new Promise(resolve => setTimeout(resolve, 15)); return json({ access_token: 'fake-rotated-access', refresh_token: 'fake-rotated-refresh', token_type: 'bearer', expires_in: 3600 }); } });
  await Promise.all([auth.withAccessToken(async () => undefined), auth.withAccessToken(async () => undefined)]);
  assert.equal(refreshes, 1);
  let entered: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const running = auth.withAccessToken(async (_token, signal) => { entered(); await new Promise<void>((_accept, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled fixture')), { once: true })); });
  await started; auth.abortAll(); await assert.rejects(running);
});

test('a rotating refresh is checkpointed before temporary identity-verification failure and recovered without reuse', async () => {
  let refreshes = 0; let failJWKS = true;
  const rotatedID = await token({});
  const auth = createAuthTestHarness({ seed: seed({ expiresAt: NOW - 1 }), now: () => NOW, openBrowser: async () => undefined, transport: async url => {
    if (url.endsWith('/.well-known/openid-configuration')) return json(discovery);
    if (url.endsWith('/.well-known/jwks.json')) return failJWKS ? json({}, 503) : json({ keys: [jwk] });
    refreshes++; return json({ access_token: 'fake-rotated-access', refresh_token: 'fake-rotated-refresh', id_token: rotatedID, token_type: 'Bearer', expires_in: 3600, scope: scopes, earliest_refresh_at: NOW / 1000 + 3000 });
  } });
  await assert.rejects(auth.withAccessToken(async () => undefined), { code: 'jwks_unavailable' });
  assert.equal((await auth.status()).registrations[0].authenticated, false);
  failJWKS = false;
  await auth.withAccessToken(async access => { assert.equal(access, 'fake-rotated-access'); });
  assert.equal(refreshes, 1);
  assert.equal((await auth.status()).registrations[0].authenticated, true);
});

test('sign-out distinguishes confirmed and unconfirmed remote revocation and retains registration', async () => {
  for (const remoteWorks of [true, false]) {
    let revocations = 0;
    const auth = createAuthTestHarness({ seed: seed(), now: () => NOW, openBrowser: async () => undefined, transport: async url => {
      if (url.endsWith('/.well-known/openid-configuration')) return json(discovery);
      revocations++; return remoteWorks ? new Response(null, { status: 200 }) : new Response(null, { status: 503 });
    } });
    assert.equal((await auth.signOut()).remoteRevocation, remoteWorks ? 'confirmed' : 'unconfirmed');
    assert.equal(revocations, remoteWorks ? 1 : 2);
    const state = await auth.status();
    assert.equal(state.registrations[0].authenticated, false);
    assert.equal(state.registrations.length, 1);
  }
});

test('request scopes survive HTTP header return and select/sign-out abort them in the same process', async () => {
  for (const action of ['select', 'signOut'] as const) {
    const auth = createAuthTestHarness({ seed: seed(), now: () => NOW, openBrowser: async () => undefined, transport: async url => url.endsWith('/.well-known/openid-configuration') ? json(discovery) : new Response(null, { status: 200 }) });
    const scope = await auth.openRequestScope();
    try {
      await auth.withAccessToken(async () => ({ fakeHeadersReceived: true }), scope.signal);
      await scope.check();
      assert.equal(scope.signal.aborted, false);
      if (action === 'select') await auth.select('fixture'); else await auth.signOut();
      assert.equal(scope.signal.aborted, true);
      await assert.rejects(scope.check(), { code: 'cancelled' });
    } finally { scope.close(); }
  }
});

test('successful login switches registration and cancels old request scopes without cancelling its own result', async () => {
  for (const registrationId of [undefined, 'other']) {
    const fixture = seed();
    fixture.registrations.push({ ...structuredClone(fixture.registrations[0]), id: 'other', label: 'Other fixture registration' });
    const harness = loginHarness({ seed: fixture });
    const retained = await harness.auth.openRequestScope();
    try {
      const status = await harness.auth.login({ registrationId });
      assert.notEqual(status.activeId, 'fixture');
      if (registrationId) assert.equal(status.activeId, registrationId);
      assert.equal(status.registrations.find(row => row.active)?.authenticated, true);
      assert.equal(retained.signal.aborted, true);
      await assert.rejects(retained.check(), { code: 'cancelled' });
    } finally { retained.close(); harness.auth.abortAll(); }
  }
  const failed = loginHarness({ seed: seed(), nonce: 'wrong' });
  const retained = await failed.auth.openRequestScope();
  try {
    await assert.rejects(failed.auth.login({ registrationId: 'fixture' }), { code: 'id_token_invalid' });
    assert.equal((await failed.auth.status()).activeId, 'fixture');
    await retained.check();
    assert.equal(retained.signal.aborted, false);
  } finally { retained.close(); failed.auth.abortAll(); }
});

test('Windows login commits selection and invalidates a disk request epoch while preserving its successful result', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-test-login-epoch-'));
  const store = createWindowsTestStore(directory);
  const fixture = seed();
  fixture.registrations.push({ ...structuredClone(fixture.registrations[0]), id: 'other', label: 'Other fixture registration' });
  await store.transaction(async state => { Object.assign(state, fixture); });
  const retained = await store.openRequestScope();
  const harness = loginHarness({ testDirectory: directory });
  try {
    const status = await harness.auth.login({ registrationId: 'other' });
    assert.equal(status.activeId, 'other');
    assert.equal(status.registrations.find(row => row.active)?.authenticated, true);
    await assert.rejects(retained.check(), { code: 'cancelled' });
    assert.equal((await harness.auth.status()).activeId, 'other');
  } finally { retained.close(); harness.auth.abortAll(); }
});

test('sign-out re-notifies scopes created after its first cancellation while waiting for the credential lock', async () => {
  for (const cancelCaller of [false, true]) {
    let held: () => void = () => undefined;
    const acquired = new Promise<void>(resolve => { held = resolve; });
    let release: () => void = () => undefined;
    let revoking: () => void = () => undefined;
    const revocationStarted = new Promise<void>(resolve => { revoking = resolve; });
    const auth = createAuthTestHarness({ seed: seed(), now: () => NOW, openBrowser: async () => undefined, transport: async (url, init) => {
      if (url.endsWith('/.well-known/openid-configuration')) return json(discovery);
      revoking();
      if (!cancelCaller) return new Response(null, { status: 200 });
      return new Promise<Response>((_accept, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('Fixture revoke cancelled')), { once: true }); });
    } });
    const holding = auth.withAccessToken(async () => { held(); await new Promise<void>(resolve => { release = resolve; }); }).then(() => undefined, error => { assert.equal(error.code, 'cancelled'); });
    await acquired;
    const controller = new AbortController();
    const loggingOut = auth.signOut(controller.signal);
    // The first cancellation has happened, but the previous operation still
    // holds the credential queue. This scope therefore observes the new epoch.
    const lateScope = await auth.openRequestScope();
    assert.equal(lateScope.signal.aborted, false);
    try {
      release();
      await holding;
      if (cancelCaller) {
        await revocationStarted;
        controller.abort();
        await assert.rejects(loggingOut, { code: 'cancelled' });
        // Wait behind the actual cleanup; caller cancellation settles sooner.
        await auth.status();
      } else {
        assert.equal((await loggingOut).remoteRevocation, 'confirmed');
      }
      assert.equal((await auth.status()).registrations[0].authenticated, false);
      assert.equal(lateScope.signal.aborted, true);
      await assert.rejects(lateScope.check(), { code: 'cancelled' });
    } finally { release(); lateScope.close(); }
  }
});

test('account selection re-notifies late scopes while holding the credential lock', async () => {
  const auth = createAuthTestHarness({ seed: seed(), now: () => NOW, openBrowser: async () => undefined, transport: async () => { throw new Error('No HTTP needed for selection'); } });
  let acquired: () => void = () => undefined;
  const started = new Promise<void>(resolve => { acquired = resolve; });
  let release: () => void = () => undefined;
  const holding = auth.withAccessToken(async () => { acquired(); await new Promise<void>(resolve => { release = resolve; }); }).then(() => undefined, error => { assert.equal(error.code, 'cancelled'); });
  await started;
  const selecting = auth.select('fixture');
  const lateScope = await auth.openRequestScope();
  assert.equal(lateScope.signal.aborted, false);
  try {
    release(); await holding; await selecting;
    assert.equal(lateScope.signal.aborted, true);
    await assert.rejects(lateScope.check(), { code: 'cancelled' });
  } finally { release(); lateScope.close(); }
});

test('authentication request accounting receives the caller cancellation signal before any HTTP request', async () => {
  const controller = new AbortController();
  let entered: () => void = () => undefined;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let requests = 0;
  const auth = createAuthTestHarness({ seed: seed({ expiresAt: NOW - 1 }), now: () => NOW, openBrowser: async () => undefined, transport: async () => { requests++; return json({}); }, onRequest: async (_kind, signal) => {
    entered();
    await new Promise<void>((_accept, reject) => { signal.addEventListener('abort', () => reject(new Error('fake accounting cancelled')), { once: true }); });
  } });
  const operation = auth.withAccessToken(async () => undefined, controller.signal);
  await waiting;
  controller.abort();
  await assert.rejects(operation, { code: 'cancelled' });
  assert.equal(requests, 0);
});

test('Windows separate-process sign-out interrupts a retained request scope after headers without waiting for the credential lock', { skip: process.platform !== 'win32', timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'siwc-test-cancel-'));
  const store = createWindowsTestStore(directory);
  await store.transaction(async state => { Object.assign(state, seed({ expiresAt: Date.now() + 3_600_000 })); });
  const authModule = new URL('../lib/auth.js', import.meta.url).href;
  const storeModule = new URL('../lib/store.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createAuthTestHarness} from ${JSON.stringify(authModule)};
    import {createWindowsTestStore} from ${JSON.stringify(storeModule)};
    const auth=createAuthTestHarness({testDirectory:process.argv[1],openBrowser:async()=>{},transport:async()=>{throw Error('No remote calls in this fixture')}});
    const scope=await auth.openRequestScope();
    await auth.withAccessToken(async()=>({headers:true}),scope.signal);
    // Keep the credential lock occupied to prove the notification is independent.
    await createWindowsTestStore(process.argv[1]).transaction(async()=>{
      console.log('HEADERS_LOCKED');
      const expiry=setTimeout(()=>{throw Error('Fixture cancellation timed out')},15000);
      try { await new Promise(resolve=>{if(scope.signal.aborted)resolve();else scope.signal.addEventListener('abort',resolve,{once:true})}); console.log('CANCELLED'); }
      finally{clearTimeout(expiry);scope.close()}
    });
  `, directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  const finished = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Isolated cancellation fixture failed'))); });
  const headers = new Promise<void>((resolve, reject) => { child.stdout.on('data', data => { output += String(data); if (output.includes('HEADERS_LOCKED')) resolve(); }); child.once('exit', code => { if (code !== 0) reject(new Error('Fixture did not reach headers')); }); });
  try {
    await headers;
    const auth = createAuthTestHarness({ testDirectory: directory, openBrowser: async () => undefined, transport: async url => url.endsWith('/.well-known/openid-configuration') ? json(discovery) : new Response(null, { status: 200 }) });
    const result = await auth.signOut();
    await finished;
    assert.equal(result.remoteRevocation, 'confirmed');
    assert.ok(output.includes('CANCELLED'));
    assert.equal((await auth.status()).registrations[0].authenticated, false);
  } finally { child.kill(); }
});
