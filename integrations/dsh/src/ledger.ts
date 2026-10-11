import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './errors.js';
import { withWindowsFileLock } from './store.js';

export type RequestKind = 'auth' | 'models' | 'inference';
interface Ledger { version: 1; armed: boolean; personalUse: boolean; auth: number; models: number; inference: number; limit: 6; updatedAt: string; stoppedFrom?: 'verification' | 'personal';
  /** Increases on every explicit human (re)start, so a running process can tell a new start from the one it stopped. */
  generation?: number; }
function location(): string {
  const local = process.env.LOCALAPPDATA;
  if (!local || !isAbsolute(local) || local.startsWith('\\\\')) throw new BridgeError('LOCAL_STATE_UNAVAILABLE', 'Windowsのローカル検証記録領域がありません。');
  return join(local, 'siwc-bridge-dsh', 'verification.json');
}
async function load(file: string): Promise<Ledger> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error();
    const row = value as Ledger;
    if (row.version !== 1 || typeof row.armed !== 'boolean' || row.limit !== 6 || [row.auth, row.models, row.inference].some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error();
    if (row.personalUse === undefined) row.personalUse = false;
    if (typeof row.personalUse !== 'boolean' || (row.personalUse && row.armed)) throw new Error();
    if (row.stoppedFrom !== undefined && (!['verification', 'personal'].includes(row.stoppedFrom) || row.armed || row.personalUse)) throw new Error();
    if (row.generation !== undefined && (!Number.isSafeInteger(row.generation) || row.generation < 0)) throw new Error();
    return row;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, armed: false, personalUse: false, auth: 0, models: 0, inference: 0, limit: 6, updatedAt: new Date().toISOString() };
    throw new BridgeError('VERIFICATION_STATE_INVALID', '検証要求の記録が不正です。推論を停止しました。');
  }
}
// Every process uses one installation-local ledger. Failed attempts count before HTTP.
async function transaction<T>(operation: (row: Ledger) => Promise<T>, signal?: AbortSignal, testFile?: string): Promise<T> {
  const file = testFile ?? location();
  await mkdir(join(file, '..'), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    return await withWindowsFileLock(`${file}.lock`, async () => {
      try {
        signal?.throwIfAborted();
        const row = await load(file);
        const result = await operation(row);
        row.updatedAt = new Date().toISOString();
        const out = await open(temporary, 'wx', 0o600);
        try { await out.writeFile(JSON.stringify(row)); await out.sync(); } finally { await out.close(); }
        await rename(temporary, file);
        return result;
      } finally { await unlink(temporary).catch(() => undefined); }
    }, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof BridgeError && error.code === 'WINDOWS_FILE_LOCKED') throw new BridgeError('VERIFICATION_LOCKED', '別プロセスが検証要求を記録中です。推論を停止しました。');
    throw error;
  }
}
export async function recordRequest(kind: RequestKind, signal?: AbortSignal): Promise<void> {
  await transaction(async row => countRequest(row, kind), signal);
}
function countRequest(row: Ledger, kind: RequestKind): void {
  if (kind === 'inference' && !row.armed && !row.personalUse) throw new BridgeError('LIVE_NOT_STARTED', row.stoppedFrom
    ? '利用上限のエラーで推論を停止しています。公式Usageを確認してから、DSH画面で /siwc resume confirmed（またはターミナルで node lib/cli.js resume）を実行して再開してください。'
    : 'ChatGPTプランの利用はまだ開始していません。初回確認（DSH画面では /siwc confirm、またはターミナルで node lib/cli.js confirm）で開始してください。');
  if (kind === 'inference' && row.armed && row.inference >= row.limit) throw new BridgeError('LIVE_BUDGET_EXHAUSTED', 'ライブ検証の6要求を使いました。自動再試行や別プロセスで続けません。');
  row[kind]++;
}
export async function armVerification(): Promise<Ledger> {
  return transaction(async row => { arm(row); return { ...row }; });
}
export async function verificationStatus(): Promise<Ledger> { return load(location()); }
/** Shared stop state for every running process: stopped, and the generation of the last human start. */
export async function usageState(): Promise<{ stopped: boolean; generation: number }> { return stateOf(await load(location())); }
function stateOf(row: Ledger): { stopped: boolean; generation: number } { return { stopped: !row.armed && !row.personalUse, generation: row.generation ?? 0 }; }
const started = (row: Ledger): void => { row.generation = (row.generation ?? 0) + 1; };
function arm(row: Ledger): void { row.armed = true; row.personalUse = false; delete row.stoppedFrom; started(row); }
function stop(row: Ledger): void {
  if (row.personalUse) row.stoppedFrom = 'personal';
  else if (row.armed) row.stoppedFrom = 'verification';
  row.armed = false; row.personalUse = false;
}
/** A quota failure disables every process until the owner explicitly starts again. */
export async function stopInference(): Promise<void> { await transaction(async row => stop(row)); }
function resume(row: Ledger, options: { settingsConfirmed: boolean }): void {
  if (options?.settingsConfirmed !== true) throw new BridgeError('SETTINGS_NOT_CONFIRMED', '本人が公式Usageの利用枠とクレジット不使用設定を保存・確認してください。');
  if (!row.stoppedFrom) throw new BridgeError('LIVE_NOT_STARTED', '停止前に本人が明示した利用モードがありません。新しく開始してください。');
  if (row.stoppedFrom === 'verification' && row.inference >= row.limit) throw new BridgeError('LIVE_BUDGET_EXHAUSTED', 'ライブ検証の6要求を使いました。検証の再開はできません。');
  row.armed = row.stoppedFrom === 'verification';
  row.personalUse = row.stoppedFrom === 'personal';
  delete row.stoppedFrom;
  started(row);
}
/** Human-confirmed recovery restores only the previously authorized mode, never resets counts. */
export async function resumeInference(options: { settingsConfirmed: boolean }): Promise<void> { await transaction(async row => resume(row, options)); }
/** The first-use plan confirmation also starts ordinary personal use. A usage-limit
 * stop or a running live verification is left as is: those are ended explicitly. */
export type StartResult = 'started' | 'already' | 'stopped' | 'verification';
function start(row: Ledger): StartResult {
  if (row.personalUse) return 'already';
  if (row.stoppedFrom) return 'stopped';
  if (row.armed) return 'verification';
  row.personalUse = true;
  started(row);
  return 'started';
}
export async function startPersonalUse(): Promise<StartResult> { return transaction(async row => start(row)); }
/** Explicit personal-use command after verification; never called by tests or login. */
function finish(row: Ledger): void {
  if (!row.armed && row.stoppedFrom !== 'verification') throw new BridgeError('LIVE_NOT_STARTED', '明示開始していない検証を終了できません。');
  row.armed = false; row.personalUse = true; delete row.stoppedFrom;
  started(row);
}
export async function finishVerification(): Promise<void> { await transaction(async row => finish(row)); }
/** Pure fixture ledger cannot read credentials; no production path override is exposed. */
export function testLedger(file: string) {
  return {
    request: (kind: RequestKind, signal?: AbortSignal) => transaction(async row => countRequest(row, kind), signal, file),
    arm: () => transaction(async row => arm(row), undefined, file),
    finish: () => transaction(async row => finish(row), undefined, file),
    stop: () => transaction(async row => stop(row), undefined, file),
    resume: (options: { settingsConfirmed: boolean }) => transaction(async row => resume(row, options), undefined, file),
    start: () => transaction(async row => start(row), undefined, file),
    status: () => load(file),
    usageState: async () => stateOf(await load(file)),
  };
}
