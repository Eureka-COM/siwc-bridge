import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { appDirectory } from './core/app.js';
import { adoptLegacyFile } from './core/store.js';

/** Non-secret selector metadata: model slugs and display names per registration. */
export interface CatalogStore {
  load(registrationId: string): Promise<readonly { id: string; name: string }[] | undefined>;
  save(registrationId: string, models: readonly { id: string; name: string }[]): Promise<void>;
}

/** This integration's storage identity (its registration is separate from every other app). */
export const DSH_APP_ID = 'siwc-bridge-dsh';

/**
 * %USERPROFILE%\.siwc-bridge\apps\siwc-bridge-dsh holds the credential store, the
 * request ledger, the model catalog, the default model and diagnostics. Not
 * %LOCALAPPDATA%: Windows keeps AppData private per packaged (MSIX) parent app, so
 * a sign-in made from a program started by such an app was invisible to DSH
 * started from Explorer. The profile folder is the same for every launch path.
 */
export function applicationDirectory(): string { return appDirectory(DSH_APP_ID); }

/** v0.2.0 to v0.3.0 kept the same files in %LOCALAPPDATA%\siwc-bridge-dsh. */
export function legacyApplicationDirectory(): string | undefined {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !local || !isAbsolute(local) || local.startsWith('\\\\') || !/^[A-Za-z]:\\/.test(local)) return undefined;
  return join(local, DSH_APP_ID);
}

/**
 * Moves the non-secret files once per process; the credential store moves its own
 * file. A failed move only means the catalog is fetched again and the default model
 * is chosen again.
 */
export async function adoptLegacyState(): Promise<void> {
  let directory: string;
  try { directory = applicationDirectory(); } catch { return; }
  const legacy = legacyApplicationDirectory();
  await Promise.all(['model-catalog.json', 'selected-model.json'].map(name => adoptLegacyFile(directory, legacy, name).catch(() => undefined)));
}

const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const safeText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 200;

/** Without `directory`, the application folder (after moving an earlier catalog once). */
export function diskCatalogStore(directory?: () => string): CatalogStore {
  const folder = directory ?? applicationDirectory;
  const ready = directory ? async () => undefined : adoptLegacyState;
  const file = () => join(folder(), 'model-catalog.json');
  return {
    async load(registrationId) {
      await ready();
      let row: { version?: unknown; registrationId?: unknown; models?: unknown } | undefined;
      try { row = JSON.parse(await readFile(file(), 'utf8')); } catch { return undefined; }
      if (!row || row.version !== 1 || row.registrationId !== registrationId || !Array.isArray(row.models) || row.models.length > 500) return undefined;
      const models: { id: string; name: string }[] = []; const ids = new Set<string>();
      for (const model of row.models as { id?: unknown; name?: unknown }[]) {
        if (!model || !safeText(model.id) || !safeText(model.name) || ids.has(model.id)) return undefined;
        ids.add(model.id); models.push({ id: model.id, name: model.name });
      }
      return models;
    },
    async save(registrationId, models) {
      if (!safeId(registrationId)) return;
      await ready();
      const target = file(); const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(temporary, JSON.stringify({ version: 1, registrationId, savedAt: new Date().toISOString(), models: models.map(({ id, name }) => ({ id, name })) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, target);
      } catch { await unlink(temporary).catch(() => undefined); }
    },
  };
}
