// Authentication, PKCE, ID-token checks and Windows DPAPI storage are the SDK's
// (scripts/sync-core.mjs). This integration keeps only its own app identity and
// its fixed per-app folder, so its registration stays separate from every other app.
// A sign-in kept in the folder used up to v0.3.0 moves into the current folder once.
import { AuthCore, systemBrowser, createAuthTestHarness as createCoreHarness } from './core/auth.js';
import { WindowsStore } from './core/store.js';
import { DSH_APP_ID, applicationDirectory, legacyApplicationDirectory } from './local-cache.js';

export * from './core/auth.js';

/** The name shown on the ChatGPT consent screen and in App limits. */
export const DSH_APP = { appId: DSH_APP_ID, appName: 'SIWC Bridge for DSH' } as const;

/** %USERPROFILE%\.siwc-bridge\apps\siwc-bridge-dsh (see applicationDirectory). */
export function dshDirectory(): string { return applicationDirectory(); }

export class AuthManager extends AuthCore {
  constructor(onRequest?: (kind: 'auth', signal: AbortSignal) => Promise<void>) {
    super({ app: { ...DSH_APP }, store: () => new WindowsStore(DSH_APP.appId, dshDirectory(), legacyApplicationDirectory()), transport: (url, init) => fetch(url, init), openBrowser: systemBrowser, onRequest, now: Date.now });
  }
}

/** Test-only harness with this integration's app name. */
export function createAuthTestHarness(options: Parameters<typeof createCoreHarness>[0]): AuthCore {
  return createCoreHarness({ appName: DSH_APP.appName, ...options });
}
