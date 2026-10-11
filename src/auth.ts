import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './errors.js';
import { readText } from './http.js';
import { validateAppIdentity, type AppIdentity } from './app.js';
import { WindowsStore, createMemoryTestStore, createWindowsTestStore, type AuthStore, type CredentialState, type Registration, type Credentials, type RequestScope } from './store.js';

const AUTH_ORIGIN = 'https://auth.openai.com';
const DISCOVERY = `${AUTH_ORIGIN}/.well-known/openid-configuration`;
const AUTHORIZE = `${AUTH_ORIGIN}/api/accounts/authorize`;
const TOKEN = `${AUTH_ORIGIN}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const TERMINAL_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

export interface AuthStatus {
  hostId: string;
  registrations: { id: string; label: string; authenticated: boolean; planAllowed: boolean; active: boolean; planConfirmed: boolean }[];
  activeId?: string;
}
export interface LoginOptions { registrationId?: string; forceConsent?: boolean; signal?: AbortSignal; }
interface Transaction {
  state: string; nonce: string; verifier: string; challenge: string; redirectUri: string; expiresAt: number; clientId?: string; consumed: boolean;
}
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; revocation_endpoint?: string; }
type Transport = (url: string, init: RequestInit) => Promise<Response>;
interface Environment {
  app: AppIdentity;
  store: () => AuthStore;
  transport: Transport;
  openBrowser: (url: string) => Promise<void>;
  onRequest?: (kind: 'auth', signal: AbortSignal) => Promise<void>;
  now: () => number;
}
function cancelError(): BridgeError { return new BridgeError('cancelled', '処理を中断しました。'); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw cancelError(); }
function permitted(c?: Credentials): boolean { return !!c && c.scopes.includes('chatgpt.tokens.use.direct') && c.scopes.includes('resource.invoke'); }
function sanitized(state: CredentialState, now: number): AuthStatus {
  return { hostId: state.hostId, activeId: state.activeId, registrations: state.registrations.map(r => {
    const authenticated = !!r.credentials && !r.pendingRefresh && (r.credentials.expiresAt > now || !!r.credentials.refreshToken);
    return { id: r.id, label: r.label, authenticated, planAllowed: authenticated && permitted(r.credentials), active: state.activeId === r.id, planConfirmed: r.planConfirmed };
  }) };
}
function active(state: CredentialState): Registration {
  const registration = state.registrations.find(r => r.id === state.activeId);
  if (!registration) throw new BridgeError('sign_in_required', 'Continue with ChatGPTでログインしてください。');
  return registration;
}
function fixedAuthEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new BridgeError('discovery_invalid', '公式Discoveryの形式を確認できません。');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new BridgeError('discovery_invalid', '公式Discoveryの接続先が不正です。'); }
  if (url.origin !== AUTH_ORIGIN || url.username || url.password || url.hash || url.search) throw new BridgeError('discovery_invalid', '公式Discoveryの接続先が不正です。');
  return url.href;
}
function safeEqual(a: string | null, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function transaction(now: number, clientId?: string): Transaction {
  const verifier = randomBytes(64).toString('base64url');
  return { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), redirectUri: '', expiresAt: now + 10 * 60_000, clientId, consumed: false };
}
function consumeCallback(tx: Transaction, url: URL, now: number): { code: string; clientId: string } {
  if (tx.consumed) throw new BridgeError('oauth_callback_reused', 'このログイン結果は使用済みです。');
  for (const parameter of ['code', 'state', 'client_id', 'error']) if (url.searchParams.getAll(parameter).length > 1) throw new BridgeError('oauth_callback_invalid', 'ログイン結果の形式が不正です。');
  if (tx.expiresAt <= now || !safeEqual(url.searchParams.get('state'), tx.state)) throw new BridgeError('oauth_state_invalid', 'ログイン試行を確認できません。もう一度開始してください。');
  tx.consumed = true;
  if (url.searchParams.has('error')) throw new BridgeError(url.searchParams.get('error') === 'access_denied' ? 'oauth_access_denied' : 'oauth_failed', '公式ログインが完了しませんでした。');
  const code = url.searchParams.get('code');
  const supplied = url.searchParams.get('client_id');
  if (!code || code.length > 8192) throw new BridgeError('oauth_callback_invalid', 'ログイン結果に認可コードがありません。');
  if (tx.clientId && supplied && supplied !== tx.clientId) throw new BridgeError('oauth_client_mismatch', '選択した登録とログイン結果が一致しません。');
  const clientId = tx.clientId ?? supplied;
  if (!clientId || clientId === 'dynamic_agent_client' || !/^[A-Za-z0-9_-]{1,200}$/.test(clientId)) throw new BridgeError('oauth_registration_incomplete', '発行された登録IDを確認できません。');
  return { code, clientId };
}
function authorizationURL(tx: Transaction, state: CredentialState, registration: Registration | undefined, appName: string, forceConsent?: boolean): string {
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({ client_id: registration?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: state.hostId, response_type: 'code', redirect_uri: tx.redirectUri, scope: SCOPES, resource: RESOURCE, state: tx.state, nonce: tx.nonce, code_challenge_method: 'S256', code_challenge: tx.challenge }).toString();
  if (!registration) url.searchParams.set('agent_name_hint', appName);
  if (registration?.credentials?.idToken) url.searchParams.set('id_token_hint', registration.credentials.idToken);
  // force_reconsent is not deployed for this integration; the documented prompt remains supported.
  if (forceConsent) url.searchParams.set('prompt', 'consent');
  return url.href;
}
async function systemBrowser(url: string): Promise<void> {
  if (process.platform !== 'win32') throw new BridgeError('windows_required', 'Windowsのシステムブラウザが必要です。');
  // URL passes through stdin, never shell interpolation, process arguments, or logs.
  await new Promise<void>((accept, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; try { $u=[Console]::In.ReadToEnd(); Start-Process -FilePath $u -WindowStyle Hidden | Out-Null; exit 0 } catch { exit 1 }'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); reject(new BridgeError('browser_unavailable', 'システムブラウザを開けませんでした。')); }, 10_000);
    child.once('error', () => { clearTimeout(timer); reject(new BridgeError('browser_unavailable', 'システムブラウザを開けませんでした。')); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) accept(); else reject(new BridgeError('browser_unavailable', 'システムブラウザを開けませんでした。')); });
    child.stdin?.end(url);
  });
}
async function browserCallback(tx: Transaction, urlFactory: () => string, openBrowser: Environment['openBrowser'], now: Environment['now'], signal: AbortSignal): Promise<{ code: string; clientId: string }> {
  checkAbort(signal);
  const server = createServer();
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((accept, reject) => { server.once('error', () => reject(new BridgeError('oauth_listener_unavailable', '127.0.0.1のログイン受付を開始できません。'))); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new BridgeError('oauth_listener_unavailable', 'ログイン受付を開始できません。');
  tx.redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
  let cleanup: () => void = () => undefined;
  const pending = new Promise<{ code: string; clientId: string }>((accept, reject) => {
    const abort = () => reject(cancelError());
    const timeout = setTimeout(() => reject(new BridgeError('oauth_timeout', 'ログインの受付期限が切れました。もう一度開始してください。')), Math.max(1, tx.expiresAt - now()));
    signal.addEventListener('abort', abort, { once: true });
    cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); server.closeAllConnections(); server.close(); };
    server.on('request', (request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
      if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${address.port}` || (request.url?.length ?? 0) > 12_000) { response.writeHead(400).end('Invalid callback.'); return; }
      let url: URL;
      try { url = new URL(request.url ?? '', tx.redirectUri); }
      catch { response.writeHead(400).end('Invalid callback.'); return; }
      if (url.origin !== `http://127.0.0.1:${address.port}` || url.pathname !== '/auth/callback') { response.writeHead(404).end('Not found.'); return; }
      const clearLocation = "window.history.replaceState({}, '', '/auth/complete');";
      const hash = createHash('sha256').update(clearLocation).digest('base64');
      response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${hash}'; frame-ancestors 'none'; base-uri 'none'`);
      const page = (message: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>siwc-bridge sign-in</title><p>${message}</p><script>${clearLocation}</script></html>`;
      if (url.searchParams.getAll('state').length !== 1 || !safeEqual(url.searchParams.get('state'), tx.state)) {
        response.writeHead(400).end(page('Invalid sign-in request. Return to the official sign-in window.'));
        return;
      }
      try { const result = consumeCallback(tx, url, now()); response.writeHead(200).end(page('Sign-in response received. You may close this window.')); accept(result); }
      catch (error) { response.writeHead(400).end(page('Sign-in could not be verified. Restart sign-in from siwc-bridge.')); reject(error); }
    });
  });
  // Prevent an unhandled rejection if cancellation arrives while the browser opens.
  void pending.catch(() => undefined);
  try { await openBrowser(urlFactory()); checkAbort(signal); return await pending; }
  finally { cleanup(); }
}

class AuthCore {
  #environment: Environment;
  #store?: AuthStore;
  #controllers = new Set<AbortController>();
  #responseSignals = new WeakMap<Response, AbortSignal>();
  constructor(environment: Environment) { this.#environment = { ...environment, app: validateAppIdentity(environment.app) }; }
  #storage(): AuthStore { return this.#store ??= this.#environment.store(); }
  async #operation<T>(callback: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController(); this.#controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try { checkAbort(combined); return await callback(combined); }
    finally { this.#controllers.delete(controller); }
  }
  abortAll(): void { for (const controller of this.#controllers) controller.abort(); }
  async openRequestScope(signal?: AbortSignal): Promise<RequestScope> {
    const controller = new AbortController(); this.#controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let underlying: RequestScope;
    try { checkAbort(combined); underlying = await this.#storage().openRequestScope(combined); }
    catch (error) { this.#controllers.delete(controller); throw error; }
    const requestSignal = AbortSignal.any([combined, underlying.signal]);
    let closed = false;
    const close = () => { if (closed) return; closed = true; requestSignal.removeEventListener('abort', close); underlying.close(); this.#controllers.delete(controller); };
    requestSignal.addEventListener('abort', close, { once: true });
    if (requestSignal.aborted) close();
    return { signal: requestSignal, check: async () => { if (closed) throw cancelError(); checkAbort(requestSignal); await underlying.check(); checkAbort(requestSignal); }, close };
  }
  async status(signal?: AbortSignal): Promise<AuthStatus> { return this.#operation(current => this.#storage().transaction(async state => sanitized(state, this.#environment.now()), current, { shared: true }), signal); }
  async select(id: string): Promise<void> {
    this.abortAll();
    await this.#storage().cancelRequests();
    await this.#operation(signal => this.#storage().transaction(async (state, checkpoint) => {
      if (!state.registrations.some(r => r.id === id)) throw new BridgeError('registration_not_found', '指定された登録がありません。');
      state.activeId = id;
      await checkpoint();
      await this.#storage().cancelRequests();
    }, signal));
  }
  async confirmPlan(): Promise<void> {
    await this.#operation(signal => this.#storage().transaction(async state => { const r = active(state); if (!permitted(r.credentials)) throw new BridgeError('plan_permission_required', 'ChatGPTプランの利用許可がありません。公式ログインで利用許可を確認してください。'); r.planConfirmed = true; }, signal));
  }
  async #request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    fixedAuthEndpoint(url);
    checkAbort(signal);
    await this.#environment.onRequest?.('auth', signal);
    checkAbort(signal);
    const current = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    try {
      const response = await this.#environment.transport(url, { ...init, signal: current, redirect: 'error' });
      this.#responseSignals.set(response, current); return response;
    }
    catch { if (signal.aborted) throw cancelError(); throw new BridgeError('auth_network_unavailable', '認証サービスへ接続できません。資格情報を保持して処理を停止しました。'); }
  }
  async #json(response: Response): Promise<Record<string, unknown>> {
    const signal = this.#responseSignals.get(response);
    try { const body = JSON.parse(await readText(response, signal)); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body as Record<string, unknown>; }
    catch (error) {
      if (signal?.aborted) throw cancelError();
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('auth_response_invalid', '認証サービスの応答を確認できません。');
    }
  }
  async #discovery(signal: AbortSignal): Promise<Discovery> {
    const response = await this.#request(DISCOVERY, {}, signal);
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new BridgeError('discovery_unavailable', '公式Discoveryを取得できません。', response.status); }
    const body = await this.#json(response);
    if (body.issuer !== AUTH_ORIGIN || fixedAuthEndpoint(body.authorization_endpoint) !== AUTHORIZE || fixedAuthEndpoint(body.token_endpoint) !== TOKEN) throw new BridgeError('discovery_invalid', '公式Discoveryの登録・認証仕様と一致しません。');
    return { issuer: AUTH_ORIGIN, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN, jwks_uri: fixedAuthEndpoint(body.jwks_uri), revocation_endpoint: body.revocation_endpoint ? fixedAuthEndpoint(body.revocation_endpoint) : undefined };
  }
  async #identity(idToken: string, clientId: string, expected: { nonce?: string; subject?: string; receivedAt?: number }, signal: AbortSignal): Promise<{ subject: string; expiresAt: number }> {
    const discovery = await this.#discovery(signal);
    const response = await this.#request(discovery.jwks_uri, {}, signal);
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new BridgeError('jwks_unavailable', '公式JWKSを取得できません。', response.status); }
    const jwks = await this.#json(response);
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks as unknown as JSONWebKeySet), { issuer: discovery.issuer, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], algorithms: ['RS256', 'ES256'], currentDate: new Date(expected.receivedAt ?? this.#environment.now()) });
      if (typeof payload.sub !== 'string' || !payload.sub || (expected.nonce !== undefined && payload.nonce !== expected.nonce) || (expected.subject !== undefined && payload.sub !== expected.subject)) throw new Error();
      return { subject: payload.sub, expiresAt: payload.exp! * 1000 };
    } catch { throw new BridgeError('id_token_invalid', 'ログインの署名・有効期限・登録または本人の一致を確認できません。'); }
  }
  #credentials(body: Record<string, unknown>, previous?: Credentials, identityExpiresAt?: number): Credentials {
    const grantedScope = body.scope ?? (previous ? previous.scopes.join(' ') : undefined);
    if (typeof grantedScope !== 'string' || (body.refresh_token !== undefined && typeof body.refresh_token !== 'string') || (body.id_token !== undefined && (typeof body.id_token !== 'string' || !body.id_token))) throw new BridgeError('auth_response_invalid', '認証サービスの資格情報形式を確認できません。');
    const scopes = [...new Set(grantedScope.split(/\s+/).filter(Boolean))];
    if (!scopes.includes('openid')) throw new BridgeError('identity_scope_required', '本人確認のscopeが付与されていません。');
    if (!previous && body.access_token === undefined && !scopes.includes('offline_access') && !scopes.includes('chatgpt.tokens.use.direct') && identityExpiresAt !== undefined) return { accessToken: '', idToken: body.id_token as string, expiresAt: identityExpiresAt, scopes, savedAt: new Date(this.#environment.now()).toISOString() };
    if (typeof body.access_token !== 'string' || !body.access_token || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer' || typeof body.expires_in !== 'number' || !Number.isFinite(this.#environment.now() + body.expires_in * 1000) || body.expires_in <= 0) throw new BridgeError('auth_response_invalid', '認証サービスの資格情報形式を確認できません。');
    if ((previous || scopes.includes('offline_access')) && (typeof body.refresh_token !== 'string' || !body.refresh_token)) throw new BridgeError('auth_response_invalid', '更新用資格情報を確認できません。');
    // Published DevKit index.ts credentialsForRequest uses Unix seconds for numbers,
    // Date.parse for strings. Preserve that interpretation without guessing unknown types.
    let earliestRefreshAt: number | undefined;
    if (body.earliest_refresh_at !== undefined) {
      if (typeof body.earliest_refresh_at === 'number' && Number.isFinite(body.earliest_refresh_at)) earliestRefreshAt = body.earliest_refresh_at * 1000;
      else if (typeof body.earliest_refresh_at === 'string' && Number.isFinite(Date.parse(body.earliest_refresh_at))) earliestRefreshAt = Date.parse(body.earliest_refresh_at);
      else throw new BridgeError('auth_response_invalid', '更新可能時刻の形式を確認できません。');
    }
    return { accessToken: body.access_token, refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined, idToken: typeof body.id_token === 'string' ? body.id_token : previous?.idToken, expiresAt: this.#environment.now() + body.expires_in * 1000, earliestRefreshAt, scopes, savedAt: new Date(this.#environment.now()).toISOString() };
  }
  async login(options: LoginOptions = {}): Promise<AuthStatus> {
    const scope = await this.openRequestScope(options.signal);
    try { return await this.#operation(signal => this.#storage().transaction(async (state, checkpoint) => {
      const registration = options.registrationId ? state.registrations.find(r => r.id === options.registrationId) : undefined;
      if (options.registrationId && !registration) throw new BridgeError('registration_not_found', '指定された登録がありません。');
      const tx = transaction(this.#environment.now(), registration?.clientId);
      const callback = await browserCallback(tx, () => authorizationURL(tx, state, registration, this.#environment.app.appName, options.forceConsent), this.#environment.openBrowser, this.#environment.now, signal);
      // Preserve an issued registration even if a one-time authorization code expires.
      const pending = registration ?? { id: randomUUID(), label: `ChatGPT registration ${state.registrations.length + 1}`, clientId: callback.clientId, planConfirmed: false };
      if (!registration) { state.registrations.push(pending); await checkpoint(); }
      const response = await this.#request(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code, code_verifier: tx.verifier, redirect_uri: tx.redirectUri, resource: RESOURCE }) }, signal);
      const body = await this.#json(response);
      if (!response.ok) throw new BridgeError(body.error === 'invalid_grant' ? 'oauth_code_expired' : 'oauth_exchange_failed', 'ログインのコード交換が完了しませんでした。保存された登録を選んで再ログインしてください。', response.status);
      if (typeof body.id_token !== 'string') throw new BridgeError('id_token_missing', '本人確認用のID tokenがありません。');
      const identity = await this.#identity(body.id_token, callback.clientId, { nonce: tx.nonce, subject: registration?.subject }, signal);
      const credentials = this.#credentials(body, undefined, identity.expiresAt);
      await scope.check(); checkAbort(signal);
      const selectionChanged = state.activeId !== pending.id;
      pending.subject = identity.subject; pending.issuer = AUTH_ORIGIN; pending.credentials = credentials; delete pending.pendingRefresh;
      state.activeId = pending.id;
      if (selectionChanged) {
        // Commit under the credential lock before invalidating every other
        // process's request epoch. Detach this successful login from its own
        // notification so the result remains a successful sign-in.
        await checkpoint();
        scope.close();
        await this.#storage().cancelRequests();
      }
      return sanitized(state, this.#environment.now());
    }, signal), scope.signal); }
    finally { scope.close(); }
  }
  async #refresh(registration: Registration, signal: AbortSignal, checkpoint: () => Promise<void>): Promise<void> {
    if (registration.pendingRefresh) {
      const pending = registration.pendingRefresh;
      if (!pending.idToken) throw new BridgeError('sign_in_required', '更新後の本人確認を完了できません。保存された登録で再ログインしてください。');
      await this.#identity(pending.idToken, registration.clientId, { subject: registration.subject, receivedAt: Date.parse(pending.savedAt) }, signal);
      registration.credentials = pending; delete registration.pendingRefresh;
      await checkpoint();
      if (pending.expiresAt - this.#environment.now() >= 60_000) return;
    }
    const existing = registration.credentials!;
    if (!existing.refreshToken) throw new BridgeError('sign_in_required', '資格情報の期限が切れました。保存された登録で再ログインしてください。');
    if (existing.earliestRefreshAt !== undefined && this.#environment.now() < existing.earliestRefreshAt) { if (existing.expiresAt <= this.#environment.now()) throw new BridgeError('refresh_not_available', '更新可能時刻に達していません。処理を停止しました。'); return; }
    const response = await this.#request(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.clientId, refresh_token: existing.refreshToken, resource: RESOURCE }) }, signal);
    const body = await this.#json(response);
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : undefined;
      if (code && TERMINAL_REFRESH.has(code)) { delete registration.credentials; delete registration.pendingRefresh; throw new BridgeError('sign_in_required', '更新用資格情報が失効しました。保存された登録で再ログインしてください。', response.status); }
      throw new BridgeError(code === 'invalid_client' ? 'oauth_client_invalid' : 'auth_temporarily_unavailable', '資格情報を更新できません。保存した資格情報を保持して処理を停止しました。', response.status);
    }
    const credentials = this.#credentials(body, existing);
    if (typeof body.id_token === 'string') {
      registration.pendingRefresh = credentials;
      // Persist the sole valid rotating refresh token before any JWKS request.
      await checkpoint();
      await this.#identity(body.id_token, registration.clientId, { subject: registration.subject }, signal);
      delete registration.pendingRefresh;
    }
    registration.credentials = credentials;
  }
  async withAccessToken<T>(operation: (token: string, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const scope = await this.openRequestScope(signal);
    try {
      // Fast path: a still-valid token needs no OS lock and no write. The
      // in-process queue is kept, so local select/sign-out ordering is unchanged.
      const fast = await this.#operation(current => this.#storage().transaction(async state => {
        const registration = active(state);
        if (!registration.credentials) throw new BridgeError('sign_in_required', '保存された登録で再ログインしてください。');
        if (!permitted(registration.credentials)) throw new BridgeError('plan_permission_required', 'ChatGPTプランの利用許可がありません。推論は送信しません。');
        if (!registration.planConfirmed) throw new BridgeError('plan_confirmation_required', '初回のChatGPTプラン利用確認を行ってください。');
        if (registration.pendingRefresh || registration.credentials.expiresAt - this.#environment.now() < 60_000) return { refresh: true as const };
        await scope.check(); checkAbort(current);
        const result = await operation(registration.credentials.accessToken, current);
        await scope.check(); checkAbort(current);
        return { refresh: false as const, result };
      }, current, { shared: true }), scope.signal);
      if (!fast.refresh) return fast.result;
      // Refresh rotates the refresh token: only under the cross-process lock.
      return await this.#operation(current => this.#storage().transaction(async (state, checkpoint) => {
      const registration = active(state);
      if (!registration.credentials) throw new BridgeError('sign_in_required', '保存された登録で再ログインしてください。');
      if (!permitted(registration.credentials)) throw new BridgeError('plan_permission_required', 'ChatGPTプランの利用許可がありません。推論は送信しません。');
      if (!registration.planConfirmed) throw new BridgeError('plan_confirmation_required', '初回のChatGPTプラン利用確認を行ってください。');
      if (registration.pendingRefresh || registration.credentials.expiresAt - this.#environment.now() < 60_000) await this.#refresh(registration, current, checkpoint);
      if (!permitted(registration.credentials)) throw new BridgeError('plan_permission_required', '更新後のChatGPTプラン利用許可がありません。推論は送信しません。');
      await scope.check(); checkAbort(current);
      const result = await operation(registration.credentials!.accessToken, current);
      await scope.check(); checkAbort(current);
      return result;
    }, current), scope.signal);
    } finally { scope.close(); }
  }
  async signOut(signal?: AbortSignal): Promise<{ remoteRevocation: 'confirmed' | 'unconfirmed' }> {
    this.abortAll();
    await this.#storage().cancelRequests(signal);
    return this.#operation(current => this.#storage().transaction(async (state, checkpoint) => {
      const registration = active(state);
      let confirmed = false;
      const renewableToken = registration.pendingRefresh?.refreshToken ?? registration.credentials?.refreshToken;
      try {
        if (renewableToken) {
          const discovery = await this.#discovery(current);
          if (discovery.revocation_endpoint) {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const response = await this.#request(discovery.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: renewableToken, token_type_hint: 'refresh_token', client_id: registration.clientId }) }, current);
                if (response.status === 200) { confirmed = (await readText(response, this.#responseSignals.get(response))) === ''; break; }
                void response.body?.cancel().catch(() => undefined);
                if (response.status < 500) break;
              } catch { if (current.aborted) break; }
              if (attempt === 0) await delay(300, undefined, { signal: current });
            }
          }
        }
      } catch { /* Local sign-out still removes tokens when remote revocation cannot be confirmed. */ }
      finally {
        delete registration.credentials; delete registration.pendingRefresh;
        // A new scope can start between the first notification and this lock.
        // Commit removal first, then interrupt that late epoch while still
        // holding the credential lock. Cancellation must not skip cleanup.
        await checkpoint();
        await this.#storage().cancelRequests();
      }
      return { remoteRevocation: confirmed ? 'confirmed' : 'unconfirmed' };
    }, current), signal);
  }
}

/** Production constructor has no endpoint, transport, storage, or credential injection. */
export class AuthManager extends AuthCore {
  constructor(options: AppIdentity & { onRequest?: (kind: 'auth', signal: AbortSignal) => Promise<void> }) {
    const app = validateAppIdentity(options);
    super({ app, store: () => new WindowsStore(app.appId), transport: (url, init) => fetch(url, init), openBrowser: systemBrowser, onRequest: options.onRequest, now: Date.now });
  }
}
/** Test-only factory always owns a fresh memory store; cannot load production credentials. */
export function createAuthTestHarness(options: { appId?: string; appName?: string; seed?: CredentialState; testDirectory?: string; transport: Transport; openBrowser: (url: string) => Promise<void>; now?: () => number; onRequest?: (kind: 'auth', signal: AbortSignal) => Promise<void> }): AuthCore {
  if (options.seed && options.testDirectory) throw new BridgeError('test_store_invalid', 'テストストアへのseed混在はできません。');
  const store = options.testDirectory ? createWindowsTestStore(options.testDirectory) : createMemoryTestStore(options.seed);
  return new AuthCore({ app: { appId: options.appId ?? 'siwc-test-app', appName: options.appName ?? 'SIWC test app' }, store: () => store, transport: options.transport, openBrowser: options.openBrowser, onRequest: options.onRequest, now: options.now ?? Date.now });
}
