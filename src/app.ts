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

/** No arbitrary path override or migration from another application's store. */
export function appDirectory(appId: string): string {
  const validated = checkedAppId(appId);
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !local || !isAbsolute(local) || local.startsWith('\\\\')) {
    throw new BridgeError('secure_storage_unavailable', 'Windowsのローカル保存領域が必要です。');
  }
  return join(local, 'siwc-bridge', 'apps', validated);
}
