import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appDirectory, legacyAppDirectory } from './app.js';
import { BridgeError } from './errors.js';
import { adoptLegacyFile, withWindowsFileLock } from './store.js';

export interface BudgetStatus {
  version: 1; enabled: boolean; auth: number; models: number; inference: number; allowedThrough: number;
  /** Increases on every explicit human start, so other processes can tell a new start from an old one. */
  generation?: number;
}
export interface BeginOptions { maxRequests: number; creditSettingsConfirmed: boolean; }
export type RequestKind = 'auth' | 'models' | 'inference';

async function load(file: string): Promise<BudgetStatus> {
  try {
    const state = JSON.parse(await readFile(file, 'utf8')) as BudgetStatus;
    if (state?.version !== 1 || typeof state.enabled !== 'boolean'
      || [state.auth, state.models, state.inference, state.allowedThrough].some(n => !Number.isSafeInteger(n) || n < 0)
      || (state.generation !== undefined && (!Number.isSafeInteger(state.generation) || state.generation < 0))) throw new Error();
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, enabled: false, auth: 0, models: 0, inference: 0, allowedThrough: 0 };
    throw new BridgeError('BUDGET_INVALID', '要求予算の記録が不正です。推論を停止しました。');
  }
}
async function transaction<T>(file: string, operation: (state: BudgetStatus) => T, signal?: AbortSignal): Promise<T> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    return await withWindowsFileLock(`${file}.lock`, async () => {
      try {
        signal?.throwIfAborted();
        const state = await load(file); const result = operation(state);
        const out = await open(temporary, 'wx', 0o600);
        try { await out.writeFile(JSON.stringify(state)); await out.sync(); } finally { await out.close(); }
        await rename(temporary, file);
        return result;
      } finally { await unlink(temporary).catch(() => undefined); }
    }, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof BridgeError && error.code === 'WINDOWS_FILE_LOCKED') throw new BridgeError('BUDGET_LOCKED', '別プロセスが要求予算を更新しています。');
    throw error;
  }
}

class BudgetCore {
  constructor(private readonly file: string, private readonly legacyDirectory?: string) {}
  /** A quota stop recorded in the earlier folder stays in force after the move. */
  private async adopt(): Promise<void> {
    try { await adoptLegacyFile(dirname(this.file), this.legacyDirectory, basename(this.file)); }
    catch { throw new BridgeError('BUDGET_INVALID', '以前の保存場所から要求予算の記録を移せません。推論を停止しました。'); }
  }
  async status(): Promise<BudgetStatus> { await this.adopt(); return load(this.file); }
  async begin(options: BeginOptions): Promise<BudgetStatus> {
    if (options.creditSettingsConfirmed !== true) throw new BridgeError('SETTINGS_NOT_CONFIRMED', '本人が公式Usageのクレジット不使用設定を保存・確認してください。');
    if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 1000) throw new BridgeError('INVALID_BUDGET', '本人が開始する要求数は1〜1000の整数で指定してください。');
    await this.adopt();
    return transaction(this.file, state => {
      if (!Number.isSafeInteger(state.inference + options.maxRequests)) throw new BridgeError('INVALID_BUDGET', '要求記録の上限に達しました。');
      state.allowedThrough = state.inference + options.maxRequests; state.enabled = true; state.generation = (state.generation ?? 0) + 1; return { ...state };
    });
  }
  async stop(): Promise<void> { await this.adopt(); await transaction(this.file, state => { state.enabled = false; }); }
  async request(kind: RequestKind, signal?: AbortSignal): Promise<void> {
    await this.adopt();
    await transaction(this.file, state => {
      if (kind === 'inference' && !state.enabled) throw new BridgeError('INFERENCE_NOT_STARTED', '推論はOFFです。本人の設定確認後に明示的に開始してください。');
      if (kind === 'inference' && state.inference >= state.allowedThrough) throw new BridgeError('REQUEST_BUDGET_EXHAUSTED', '本人が指定した要求数を使いました。自動で続行しません。');
      if (!Number.isSafeInteger(state[kind] + 1)) throw new BridgeError('INVALID_BUDGET', '要求記録の上限に達しました。');
      state[kind]++;
    }, signal);
  }
}
export class RequestBudget extends BudgetCore {
  constructor(appId: string) { super(join(appDirectory(appId), 'requests.json'), legacyAppDirectory(appId)); }
}
/** Synthetic file only. Not exported from the package entry point. */
export function createBudgetTestHarness(file: string) { return new BudgetCore(file); }
