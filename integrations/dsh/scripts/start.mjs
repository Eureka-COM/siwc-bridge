import { join } from 'node:path';
import { paths, readSelectedModel, runDsh, WEB_PROFILE, writeIsolationPatch } from './dsh-env.mjs';

const args = process.argv.slice(2); const modelIndex = args.indexOf('--model');
if (modelIndex >= 0 && !args[modelIndex + 1]) throw new Error('--model には認証済みのモデル slug が必要です。');
const selected = await readSelectedModel(modelIndex >= 0 ? args[modelIndex + 1] : undefined);
if (modelIndex >= 0) args.splice(modelIndex, 2);
const patch = join(paths.work, 'web-isolation.patch.yml');
await writeIsolationPatch(patch, { model: selected.model, webCredentials: true });
const result = await runDsh(['--profile', WEB_PROFILE, '--patch', patch, ...args], {
  env: selected.registrationId ? { SIWC_REGISTRATION_ID: selected.registrationId } : {}, timeoutMs: 0,
});
process.exitCode = result.code;
