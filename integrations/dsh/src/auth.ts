// Authentication, PKCE, ID-token checks and Windows DPAPI storage are the SDK's
// (scripts/sync-core.mjs). This integration keeps only its own app identity and
// its fixed per-app folder, so its registration stays separate from every other app.
import { join, isAbsolute } from 'node:path';
import { AuthCore, systemBrowser, createAuthTestHarness as createCoreHarness } from './core/auth.js';
import { WindowsStore } from './core/store.js';
import { BridgeError } from './core/errors.js';

export * from './core/auth.js';

/** The name shown on the ChatGPT consent screen and in App limits. */
export const DSH_APP = { appId: 'siwc-bridge-dsh', appName: 'SIWC Bridge for DSH' } as const;

/** %LOCALAPPDATA%\siwc-bridge-dsh — unchanged since v0.2.0, so an existing sign-in stays valid. */
export function dshDirectory(): string {
  const local = process.env.LOCALAPPDATA;
  if (!local || process.platform !== 'win32' || !isAbsolute(local) || local.startsWith('\\\\')) throw new BridgeError('secure_storage_unavailable', 'Windowsのローカル保存領域が必要です。');
  return join(local, DSH_APP.appId);
}

export class AuthManager extends AuthCore {
  constructor(onRequest?: (kind: 'auth', signal: AbortSignal) => Promise<void>) {
    super({ app: { ...DSH_APP }, store: () => new WindowsStore(DSH_APP.appId, dshDirectory()), transport: (url, init) => fetch(url, init), openBrowser: systemBrowser, onRequest, now: Date.now });
  }
}

/** Test-only harness with this integration's app name. */
export function createAuthTestHarness(options: Parameters<typeof createCoreHarness>[0]): AuthCore {
  return createCoreHarness({ appName: DSH_APP.appName, ...options });
}
