import { join } from 'node:path';
import { paths, readSelectedModel, runDsh, runNode, verifyInstalledPlugin, WEB_PROFILE, writeRuntimePatch } from './dsh-env.mjs';

const args = process.argv.slice(2); const modelIndex = args.indexOf('--model');
if (modelIndex >= 0 && !args[modelIndex + 1]) throw new Error('--model にはモデルのslugを指定してください。');
// The launcher always starts what this folder holds: a plugin installed from an older build is replaced first.
let current = false;
try { current = (await verifyInstalledPlugin(WEB_PROFILE)).mismatches.length === 0; } catch { current = false; }
if (!current) {
  console.log('Installing the current build of the plugin into DSH (first start after an update)...');
  const setup = await runNode(join(paths.root, 'scripts', 'setup.mjs'), [], { cwd: paths.root, timeoutMs: 600_000 });
  if (setup.code !== 0) { console.log('Could not install the plugin. Run "npm.cmd run setup" in this folder to see the error.'); process.exit(1); }
}
const selected = await readSelectedModel(modelIndex >= 0 ? args[modelIndex + 1] : undefined);
if (modelIndex >= 0) args.splice(modelIndex, 2);
if (!selected.model) console.log(`Default model is not set${selected.reason ? ` (${selected.reason})` : ''}. In DSH, choose a "ChatGPT plan (SIWC)" model in the composer's model menu, or run /siwc login.`);
const patch = join(paths.work, 'runtime.patch.yml');
await writeRuntimePatch(patch, { model: selected.model, webCredentials: true });
const result = await runDsh(['--profile', WEB_PROFILE, '--patch', patch, ...args], { cwd: process.env.USERPROFILE ?? paths.root, timeoutMs: 0 });
process.exitCode = result.code;
