import { join, isAbsolute } from 'node:path';
import { BridgeError } from './errors.js';

export interface AppIdentity { appId: string; appName: string; }

function checkedAppId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(value) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value)) {
    throw new BridgeError('app_identity_invalid', 'appIdはWindows予約名を除く、安全な小文字のアプリIDにしてください。');
  }
  return value;
}

/** Display metadata and storage identity are deliberately separate. */
export function validateAppIdentity(value: AppIdentity): AppIdentity {
  if (!value || typeof value !== 'object') throw new BridgeError('app_identity_invalid', 'appIdと実際のappNameが必要です。');
  const appId = checkedAppId(value.appId);
  if (typeof value.appName !== 'string' || !value.appName.trim() || value.appName.length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value.appName)) {
    throw new BridgeError('app_identity_invalid', 'appNameは制御文字を含まない100文字以内の実際のアプリ名にしてください。');
  }
  return { appId, appName: value.appName.trim() };
}

function windowsFolder(value: string | undefined): string | undefined {
  if (process.platform !== 'win32' || !value || !isAbsolute(value) || value.startsWith('\\\\') || !/^[A-Za-z]:\\/.test(value)) return undefined;
  return value;
}

/**
 * %USERPROFILE%\.siwc-bridge\apps\<appId>. Not %LOCALAPPDATA%: Windows gives a
 * process started from a packaged (MSIX) app its own private copy of AppData, so
 * the same user would see a different sign-in depending on how a program was
 * launched. The profile folder is the same for every launch path.
 * No arbitrary path override, and no migration from another application's store.
 */
export function appDirectory(appId: string): string {
  const validated = checkedAppId(appId);
  const profile = windowsFolder(process.env.USERPROFILE);
  if (!profile) throw new BridgeError('secure_storage_unavailable', 'Windowsのユーザーフォルダが必要です。');
  return join(profile, '.siwc-bridge', 'apps', validated);
}

/** Where v0.2 kept the same app's files; read only to move them once into appDirectory. */
export function legacyAppDirectory(appId: string): string | undefined {
  const validated = checkedAppId(appId);
  const local = windowsFolder(process.env.LOCALAPPDATA);
  return local ? join(local, 'siwc-bridge', 'apps', validated) : undefined;
}
