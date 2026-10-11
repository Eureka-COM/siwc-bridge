import { join } from 'node:path';
import { paths, readSelectedModel, runDsh, WEB_PROFILE, writeRuntimePatch } from './dsh-env.mjs';

const args = process.argv.slice(2); const modelIndex = args.indexOf('--model');
if (modelIndex >= 0 && !args[modelIndex + 1]) throw new Error('--model にはモデルのslugを指定してください。');
const selected = await readSelectedModel(modelIndex >= 0 ? args[modelIndex + 1] : undefined);
if (modelIndex >= 0) args.splice(modelIndex, 2);
if (!selected.model) console.log('既定モデルは未設定です。DSH画面の入力欄で「ChatGPT plan (SIWC)」のモデルを選ぶか、/siwc login でサインインしてください。');
const patch = join(paths.work, 'runtime.patch.yml');
await writeRuntimePatch(patch, { model: selected.model, webCredentials: true });
const result = await runDsh(['--profile', WEB_PROFILE, '--patch', patch, ...args], { cwd: process.env.USERPROFILE ?? paths.root, timeoutMs: 0 });
process.exitCode = result.code;
