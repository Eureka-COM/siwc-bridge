import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { BridgeError } from './errors.js';

/** Non-secret selector metadata: model slugs and display names per registration. */
export interface CatalogStore {
  load(registrationId: string): Promise<readonly { id: string; name: string }[] | undefined>;
  save(registrationId: string, models: readonly { id: string; name: string }[]): Promise<void>;
}

/** The same per-user application folder as the credential store and request ledger. */
export function applicationDirectory(): string {
  const local = process.env.LOCALAPPDATA;
  if (!local || !isAbsolute(local) || local.startsWith('\\\\')) throw new BridgeError('LOCAL_STATE_UNAVAILABLE', 'Windowsのローカル設定領域がありません。');
  return join(local, 'siwc-bridge-dsh');
}

const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const safeText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 200;

export function diskCatalogStore(directory: () => string = applicationDirectory): CatalogStore {
  const file = () => join(directory(), 'model-catalog.json');
  return {
    async load(registrationId) {
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
      const target = file(); const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(temporary, JSON.stringify({ version: 1, registrationId, savedAt: new Date().toISOString(), models: models.map(({ id, name }) => ({ id, name })) }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, target);
      } catch { await unlink(temporary).catch(() => undefined); }
    },
  };
}
