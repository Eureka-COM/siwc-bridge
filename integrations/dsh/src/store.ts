import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from './errors.js';

export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  earliestRefreshAt?: number;
  scopes: string[];
  savedAt: string;
}
export interface Registration {
  id: string;
  label: string;
  clientId: string;
  subject?: string;
  issuer?: string;
  planConfirmed: boolean;
  credentials?: Credentials;
  pendingRefresh?: Credentials;
}
export interface CredentialState {
  version: 1;
  hostId: string;
  activeId?: string;
  registrations: Registration[];
}
export interface TransactionOptions {
  /** Read-only: serialize in-process but skip the OS lock and reuse the decrypted
   * snapshot while the encrypted file is unchanged. The operation must not modify
   * state or call checkpoint; doing so fails before anything is written. */
  shared?: boolean;
}
export interface AuthStore {
  transaction<T>(operation: (state: CredentialState, checkpoint: () => Promise<void>) => Promise<T>, signal?: AbortSignal, options?: TransactionOptions): Promise<T>;
  openRequestScope(signal?: AbortSignal): Promise<RequestScope>;
  cancelRequests(signal?: AbortSignal): Promise<void>;
}
export interface RequestScope { signal: AbortSignal; check(): Promise<void>; close(): void; }

function initialState(): CredentialState {
  return { version: 1, hostId: `urn:uuid:${randomUUID()}`, registrations: [] };
}
function cancelled(): BridgeError { return new BridgeError('cancelled', '処理を中断しました。'); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw cancelled(); }

// A per-process queue complements the Windows exclusive FileShare.None lock.
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  const previous = queues.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => { checkAbort(signal); return operation(); });
  // The queue tail stays attached until the underlying operation unwinds, even
  // when its waiting caller has already received cancellation.
  const tail = pending.then(() => undefined, () => undefined).finally(() => { if (queues.get(key) === tail) queues.delete(key); });
  queues.set(key, tail);
  if (!signal) return pending;
  let abort: () => void = () => undefined;
  const cancelledWait = new Promise<never>((_accept, reject) => {
    abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([pending, cancelledWait]); }
  finally { signal.removeEventListener('abort', abort); }
}

interface PipeSession { read(): Promise<string>; write(value: string): void; close(): void; closed: Promise<void>; }
async function helper(mode: string, value: string, signal?: AbortSignal): Promise<PipeSession> {
  checkAbort(signal);
  if (process.platform !== 'win32') throw new BridgeError('secure_storage_unavailable', 'Windowsの保護された保存領域が必要です。');
  const script = fileURLToPath(new URL('../scripts/dpapi.ps1', import.meta.url));
  const pipeName = `dsh-siwc-${randomUUID()}`;
  let child: ChildProcess;
  let socket: Socket | undefined;
  let terminated = false;
  const timeout = setTimeout(() => stop(), 12_000);
  const abort = () => stop();
  function stop() { if (terminated) return; terminated = true; socket?.destroy(); child?.kill(); clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  signal?.addEventListener('abort', abort, { once: true });
  child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PipeName', pipeName, '-Mode', mode], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  try {
    await new Promise<void>((accept, reject) => {
      let ready = '';
      child.stdout?.on('data', data => { ready += String(data); if (ready.includes('ready')) accept(); });
      child.once('error', () => reject(new BridgeError('secure_storage_unavailable', 'Windows秘密ストアを開始できません。')));
      child.once('exit', () => reject(new BridgeError('secure_storage_unavailable', 'Windows秘密ストアを利用できません。')));
    });
    checkAbort(signal);
    socket = createConnection(`\\\\.\\pipe\\${pipeName}`);
    await new Promise<void>((accept, reject) => { socket!.once('connect', accept); socket!.once('error', () => reject(new BridgeError('secure_storage_unavailable', 'Windows秘密ストアへ接続できません。'))); });
    let buffer = '';
    let failure = false;
    const lines: string[] = [];
    let waiter: { accept: (line: string) => void; reject: (error: Error) => void } | undefined;
    socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += String(data);
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (waiter) { const active = waiter; waiter = undefined; active.accept(line); } else lines.push(line);
      }
    });
    const lost = () => { failure = true; waiter?.reject(signal?.aborted ? cancelled() : new BridgeError('secure_storage_unavailable', `Windows秘密ストアの${mode}処理が完了しませんでした。`)); waiter = undefined; };
    socket.on('error', lost); socket.on('close', lost);
    socket.write(`${value}\n`);
    return {
      read: async () => {
        if (lines.length) { const line = lines.shift()!; if (mode === 'lock' && line === 'locked') { clearTimeout(timeout); signal?.removeEventListener('abort', abort); } return line; }
        if (failure || terminated) throw signal?.aborted ? cancelled() : new BridgeError('secure_storage_unavailable', 'Windows秘密ストアの処理が完了しませんでした。');
        return new Promise<string>((accept, reject) => { waiter = { accept: line => { if (mode === 'lock' && line === 'locked') { clearTimeout(timeout); signal?.removeEventListener('abort', abort); } accept(line); }, reject }; });
      },
      write: text => socket!.write(`${text}\n`),
      close: stop,
      closed,
    };
  } catch (error) { stop(); throw error; }
}
async function acquireFileLock(filename: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<PipeSession> {
  const start = Date.now();
  for (;;) {
    checkAbort(signal);
    const lock = await helper('lock', Buffer.from(filename).toString('base64'), signal);
    let acquired = false;
    try {
      const response = await lock.read();
      if (response === 'locked') { acquired = true; return lock; }
      if (response !== 'busy' || Date.now() - start >= timeoutMs) throw new BridgeError('credential_store_busy', '別のプロセスが資格情報を使用中です。処理終了後に再実行してください。');
    } finally { if (!acquired) { lock.close(); await lock.closed; } }
    await delay(150, undefined, { signal });
  }
}
/** Internal OS lock only: never reads or decrypts a credential file. */
export async function withWindowsFileLock<T>(filename: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return serialized(`file-lock:${resolve(filename)}`, async () => {
    let lock: PipeSession;
    try { lock = await acquireFileLock(filename, signal, 15_000); }
    catch { checkAbort(signal); throw new BridgeError('WINDOWS_FILE_LOCKED', 'Windowsの排他ファイルロックを取得できません。'); }
    try { checkAbort(signal); return await operation(); }
    finally { try { lock.write('release'); } finally { lock.close(); await lock.closed; } }
  }, signal);
}
async function transform(mode: string, data: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const pipe = await helper(mode, data.toString('base64'), signal);
  try { return Buffer.from(await pipe.read(), 'base64'); }
  finally { pipe.close(); }
}
async function secureFile(filename: string, signal?: AbortSignal): Promise<void> {
  const pipe = await helper('secure-file', Buffer.from(filename).toString('base64'), signal);
  try { if (await pipe.read() !== 'ok') throw new BridgeError('secure_storage_unavailable', '秘密ファイルのACLを設定できません。'); }
  finally { pipe.close(); }
}
// Each PowerShell helper start costs roughly 0.2s or more on Windows. ACLs are
// applied once per process for a directory or file, and again when its identity changes.
const securedDirectories = new Map<string, string>();
const securedFiles = new Map<string, string>();
async function prepareDirectory(directory: string, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory, { bigint: true });
  if (info.isSymbolicLink()) throw new BridgeError('secure_storage_unavailable', '秘密ストアにリンク先は使用できません。');
  const key = resolve(directory).toLowerCase(), identity = `${info.dev}:${info.ino}`;
  if (securedDirectories.get(key) === identity) return;
  const acl = await helper('secure-directory', Buffer.from(directory).toString('base64'), signal);
  try { if (await acl.read() !== 'ok') throw new BridgeError('secure_storage_unavailable', '秘密ストアのACLを設定できません。'); } finally { acl.close(); }
  securedDirectories.set(key, identity);
}
/** File identity changes on every atomic replacement (rename) and on in-place writes. */
async function fileIdentity(filename: string): Promise<string> {
  const info = await stat(filename, { bigint: true });
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}
const GENERATION_FILE = 'request-generation';
async function readGeneration(directory: string): Promise<string> {
  const filename = join(directory, GENERATION_FILE);
  if (!(await lstat(filename)).isFile() || (await lstat(filename)).isSymbolicLink()) throw new BridgeError('request_scope_unavailable', 'ローカルの中断状態を確認できません。');
  const value = (await readFile(filename, 'utf8')).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new BridgeError('request_scope_unavailable', 'ローカルの中断状態を確認できません。');
  return value;
}
async function ensureGeneration(directory: string, signal?: AbortSignal): Promise<string> {
  await prepareDirectory(directory, signal);
  const filename = join(directory, GENERATION_FILE);
  try {
    const file = await open(filename, 'wx', 0o600);
    try { await file.writeFile(`${randomUUID()}\n`); await file.sync(); } finally { await file.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if ((await lstat(filename)).isSymbolicLink()) throw new BridgeError('request_scope_unavailable', 'ローカルの中断状態を確認できません。');
  const identity = await fileIdentity(filename), key = resolve(filename).toLowerCase();
  if (securedFiles.get(key) !== identity) { await secureFile(filename, signal); securedFiles.set(key, await fileIdentity(filename)); }
  checkAbort(signal);
  return readGeneration(directory);
}
async function cancelDiskRequests(directory: string, signal?: AbortSignal): Promise<void> {
  await prepareDirectory(directory, signal);
  const filename = join(directory, GENERATION_FILE);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${randomUUID()}\n`); await file.sync(); } finally { await file.close(); }
    await secureFile(temporary, signal);
    checkAbort(signal);
    // Deliberately independent of the credential lock: sign-out must interrupt
    // the process holding that lock before it can revoke the renewable session.
    await rename(temporary, filename);
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
async function openDiskRequestScope(directory: string, signal?: AbortSignal): Promise<RequestScope> {
  checkAbort(signal);
  let generation: string;
  try { generation = await ensureGeneration(directory, signal); }
  catch (error) { if (signal?.aborted) throw cancelled(); if (error instanceof BridgeError) throw error; throw new BridgeError('request_scope_unavailable', 'ローカルの中断状態を確認できません。要求は開始しません。'); }
  const controller = new AbortController();
  let closed = false;
  let checking = false;
  const close = () => { if (closed) return; closed = true; clearInterval(timer); signal?.removeEventListener('abort', abort); };
  const abort = () => { controller.abort(); close(); };
  const timer = setInterval(() => {
    if (closed || checking) return;
    checking = true;
    void readGeneration(directory).then(value => { if (!closed && value !== generation) abort(); }, () => { if (!closed) abort(); }).finally(() => { checking = false; });
  }, 100);
  timer.unref();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  // Close the setup race between the initial read and starting observation.
  try { if (await readGeneration(directory) !== generation) abort(); } catch { abort(); }
  return {
    signal: controller.signal,
    check: async () => {
      if (closed || controller.signal.aborted) throw cancelled();
      try { if (await readGeneration(directory) !== generation) abort(); } catch { abort(); }
      checkAbort(controller.signal);
    },
    close,
  };
}

function validateState(value: unknown): CredentialState {
  if (!value || typeof value !== 'object') throw new BridgeError('secure_storage_invalid', '秘密ストアの形式が不正です。');
  const state = value as CredentialState;
  if (state.version !== 1 || !/^urn:uuid:[0-9a-f-]{36}$/i.test(state.hostId) || !Array.isArray(state.registrations)) throw new BridgeError('secure_storage_invalid', '秘密ストアの形式が不正です。');
  const ids = new Set<string>();
  for (const registration of state.registrations) {
    if (typeof registration.id !== 'string' || ids.has(registration.id) || typeof registration.label !== 'string' || typeof registration.clientId !== 'string' || registration.clientId === 'dynamic_agent_client' || typeof registration.planConfirmed !== 'boolean') throw new BridgeError('secure_storage_invalid', '登録の対応関係が不正です。');
    ids.add(registration.id);
    for (const c of [registration.credentials, registration.pendingRefresh]) {
      if (!c) continue;
      if (typeof registration.subject !== 'string' || registration.issuer !== 'https://auth.openai.com' || typeof c.accessToken !== 'string' || (c.refreshToken !== undefined && typeof c.refreshToken !== 'string') || (c.idToken !== undefined && typeof c.idToken !== 'string') || !Number.isFinite(c.expiresAt) || (c.earliestRefreshAt !== undefined && !Number.isFinite(c.earliestRefreshAt)) || !Array.isArray(c.scopes) || c.scopes.some(scope => typeof scope !== 'string') || typeof c.savedAt !== 'string' || !Number.isFinite(Date.parse(c.savedAt))) throw new BridgeError('secure_storage_invalid', '保存された資格情報の対応関係が不正です。');
    }
  }
  if (state.activeId !== undefined && !ids.has(state.activeId)) throw new BridgeError('secure_storage_invalid', '有効な登録が見つかりません。');
  return state;
}

export class WindowsStore implements AuthStore {
  #directory: string;
  constructor() {
    const local = process.env.LOCALAPPDATA;
    if (!local || process.platform !== 'win32' || !isAbsolute(local) || local.startsWith('\\\\')) throw new BridgeError('secure_storage_unavailable', 'Windowsのローカル保存領域が必要です。');
    this.#directory = join(local, 'siwc-bridge-dsh');
  }
  async transaction<T>(operation: (state: CredentialState, checkpoint: () => Promise<void>) => Promise<T>, signal?: AbortSignal, options?: TransactionOptions): Promise<T> {
    return diskTransaction(this.#directory, operation, signal, options);
  }
  async openRequestScope(signal?: AbortSignal): Promise<RequestScope> { return openDiskRequestScope(this.#directory, signal); }
  async cancelRequests(signal?: AbortSignal): Promise<void> { return cancelDiskRequests(this.#directory, signal); }
}
/** Decrypted snapshot per credential file, valid only while the file identity is unchanged. */
const snapshots = new Map<string, { identity: string; json: string }>();
function sharedViolation(): never { throw new BridgeError('secure_storage_invalid', '読み取り専用の資格情報処理で変更が要求されました。保存は行っていません。'); }
async function loadState(filename: string, signal?: AbortSignal): Promise<CredentialState | undefined> {
  let identity: string;
  try {
    if ((await lstat(filename)).isSymbolicLink()) throw new BridgeError('secure_storage_unavailable', '秘密ストアにリンク先は使用できません。');
    identity = await fileIdentity(filename);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const key = resolve(filename).toLowerCase();
  const cached = snapshots.get(key);
  if (cached?.identity === identity) return validateState(JSON.parse(cached.json));
  await secureFile(filename, signal);
  const encrypted = await readFile(filename);
  const plaintext = await transform('unprotect', encrypted, signal);
  try {
    const json = plaintext.toString('utf8');
    const state = validateState(JSON.parse(json));
    // Re-check after decrypting: a concurrent replacement must not be cached under the new identity.
    if (await fileIdentity(filename).catch(() => undefined) === identity) snapshots.set(key, { identity, json });
    return state;
  } finally { plaintext.fill(0); }
}
async function diskTransaction<T>(directory: string, operation: (state: CredentialState, checkpoint: () => Promise<void>) => Promise<T>, signal?: AbortSignal, options: TransactionOptions = {}): Promise<T> {
  return serialized(directory, async () => {
    checkAbort(signal);
    try {
      await prepareDirectory(directory, signal);
      const filename = join(directory, 'credentials.dpapi');
      if (options.shared) {
        // Atomic rename means a reader sees either the old or new complete file.
        // No OS lock: other processes serialize their own writes and refreshes.
        const state = await loadState(filename, signal) ?? initialState();
        const before = JSON.stringify(state);
        const result = await operation(state, async () => sharedViolation());
        if (JSON.stringify(state) !== before) sharedViolation();
        return result;
      }
      const lock = await acquireFileLock(join(directory, 'session.lock'), signal, 10_000);
      try {
        let state = await loadState(filename, signal);
        if (state === undefined) { state = initialState(); await save(filename, state, signal); }
        const working = state;
        const before = JSON.stringify(working);
        try { return await operation(working, () => save(filename, validateState(working))); }
        finally { if (JSON.stringify(working) !== before) await save(filename, validateState(working)); }
      } finally { try { lock.write('release'); } finally { lock.close(); await lock.closed; } }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (signal?.aborted) throw cancelled();
      throw new BridgeError('secure_storage_unavailable', '保護された資格情報を読み書きできません。平文への切り替えは行いません。');
    }
  }, signal);
}
async function save(filename: string, state: CredentialState, signal?: AbortSignal): Promise<void> {
  const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
  let encrypted: Buffer;
  try { encrypted = await transform('protect', plaintext, signal); } finally { plaintext.fill(0); }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(encrypted); await file.sync(); } finally { await file.close(); }
    await secureFile(temporary, signal);
    checkAbort(signal);
    await rename(temporary, filename);
    // The renamed file already carries the secured ACL applied to the temporary file.
    snapshots.set(resolve(filename).toLowerCase(), { identity: await fileIdentity(filename), json: JSON.stringify(state) });
  } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

/** Internal testing seam: never reads the production store or uses real credentials. */
export function createMemoryTestStore(seed?: CredentialState): AuthStore {
  let state = seed ? structuredClone(validateState(seed)) : initialState();
  const key = randomUUID();
  const scopes = new Set<AbortController>();
  return {
    transaction: (operation, signal, options) => serialized(key, async () => {
      checkAbort(signal); const working = structuredClone(state);
      if (options?.shared) {
        const before = JSON.stringify(working);
        const result = await operation(working, async () => sharedViolation());
        if (JSON.stringify(working) !== before) sharedViolation();
        return result;
      }
      try { return await operation(working, async () => { state = structuredClone(validateState(working)); }); } finally { state = validateState(working); }
    }, signal),
    openRequestScope: async signal => { checkAbort(signal); const controller = new AbortController(); scopes.add(controller); const abort = () => controller.abort(); let closed = false; signal?.addEventListener('abort', abort, { once: true }); return { signal: controller.signal, check: async () => { if (closed) throw cancelled(); checkAbort(controller.signal); }, close: () => { closed = true; scopes.delete(controller); signal?.removeEventListener('abort', abort); } }; },
    cancelRequests: async signal => { checkAbort(signal); for (const scope of scopes) scope.abort(); },
  };
}
/** Windows DPAPI tests can use only an isolated directory under the OS temp root. */
export function createWindowsTestStore(directory: string): AuthStore {
  const name = resolve(directory);
  const remainder = relative(resolve(tmpdir()), name);
  if (!remainder || remainder.startsWith('..') || isAbsolute(remainder) || !name.includes('dsh-siwc-test-')) throw new BridgeError('test_store_invalid', 'テスト専用の一時領域が必要です。');
  return { transaction: (operation, signal, options) => diskTransaction(name, operation, signal, options), openRequestScope: signal => openDiskRequestScope(name, signal), cancelRequests: signal => cancelDiskRequests(name, signal) };
}
