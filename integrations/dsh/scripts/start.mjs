import { join } from 'node:path';
import { paths, readSelectedModel, runDsh, WEB_PROFILE, writeRuntimePatch } from './dsh-env.mjs';

const args = process.argv.slice(2); const modelIndex = args.indexOf('--model');
if (modelIndex >= 0 && !args[modelIndex + 1]) throw new Error('--model にはモデルのslugを指定してください。');
const selected = await readSelectedModel(modelIndex >= 0 ? args[modelIndex + 1] : undefined);
if (modelIndex >= 0) args.splice(modelIndex, 2);
if (!selected.model) console.log(`Default model is not set${selected.reason ? ` (${selected.reason})` : ''}. In DSH, choose a "ChatGPT plan (SIWC)" model in the composer's model menu, or run /siwc login.`);
const patch = join(paths.work, 'runtime.patch.yml');
await writeRuntimePatch(patch, { model: selected.model, webCredentials: true });
const result = await runDsh(['--profile', WEB_PROFILE, '--patch', patch, ...args], { cwd: process.env.USERPROFILE ?? paths.root, timeoutMs: 0 });
process.exitCode = result.code;
