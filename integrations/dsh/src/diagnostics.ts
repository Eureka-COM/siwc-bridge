import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { applicationDirectory } from './local-cache.js';

/**
 * Local diagnostics: one line per model request with machine labels only —
 * time, model, outcome, HTTP status, request ID, duration, and the names of
 * events or history parts that were skipped. Never prompts, replies, tool data,
 * tokens or provider error text. Kept under the app folder, rotated at 512 KiB.
 */
export interface Diagnostics {
  record(fields: Record<string, string | number | undefined>): void;
  tail(lines: number): Promise<string[]>;
  readonly location: string;
}

const LIMIT = 512 * 1024;
const safe = (value: string | number): string => String(value).replace(/[^A-Za-z0-9_.:,\-[\]/=+]/g, '_').slice(0, 2000);

export function diskDiagnostics(directory: () => string = applicationDirectory): Diagnostics {
  let queue: Promise<void> = Promise.resolve();
  const file = () => join(directory(), 'diagnostics.log');
  let location = '%LOCALAPPDATA%\\siwc-bridge-dsh\\diagnostics.log';
  try { location = file(); } catch { /* not on Windows: location stays descriptive */ }
  return {
    location,
    record(fields) {
      const line = [new Date().toISOString(), ...Object.entries(fields).filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${safe(key)}=${safe(value!)}`)].join(' ') + '\n';
      queue = queue.then(async () => {
        const target = file();
        await mkdir(directory(), { recursive: true });
        const size = await stat(target).then(info => info.size, () => 0);
        if (size > LIMIT) await rename(target, `${target}.1`).catch(() => undefined);
        await appendFile(target, line, { encoding: 'utf8', mode: 0o600 });
      }).catch(() => undefined);
    },
    async tail(lines) {
      await queue;
      try { return (await readFile(file(), 'utf8')).trimEnd().split(/\r?\n/).slice(-lines); } catch { return []; }
    },
  };
}

/** No-op diagnostics for tests and hosts that do not want a log. */
export const noDiagnostics: Diagnostics = { record() {}, async tail() { return []; }, location: '' };
