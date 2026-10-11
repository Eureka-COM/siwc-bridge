import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { initializeProfile, paths, resolveNpmCli, runDsh, runNode, verifiedArchive, verifyInstalledPlugin, WEB_PROFILE, writeIsolationPatch } from './dsh-env.mjs';

await mkdir(paths.workspace, { recursive: true });
const npmCli = resolveNpmCli();
const built = await runNode(npmCli, ['run', 'build'], { cwd: paths.root, timeoutMs: 120_000 });
if (built.code !== 0) throw new Error('build が失敗したため dsh へ導入しません。');
await initializeProfile(WEB_PROFILE, 'web');
const artifacts = join(paths.work, 'packages'); await mkdir(artifacts, { recursive: true });
const packed = await runNode(npmCli, ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], { cwd: paths.root, capture: true, timeoutMs: 120_000 });
if (packed.code !== 0) throw new Error(`npm pack に失敗しました: ${packed.stderr.trim()}`);
const metadata = JSON.parse(packed.stdout); const archive = await verifiedArchive(join(artifacts, metadata[0].filename));
// Same-version local tarballs may be cached by pnpm; remove this bundle before re-adding the rebuilt archive.
const previous = await runDsh(['--profile', WEB_PROFILE, '--dump-config'], { capture: true });
if (previous.code !== 0) throw new Error('既存 dsh profile の登録確認に失敗しました。');
if (previous.stdout.includes('name: dsh-siwc-bridge')) {
  const removed = await runDsh(['plugin', '--profile', WEB_PROFILE, 'remove', 'dsh-siwc-bridge'], { env: { npm_config_ignore_scripts: 'true' }, timeoutMs: 120_000 });
  if (removed.code !== 0) throw new Error('再導入前のプラグイン登録解除に失敗しました。');
}
const installed = await runDsh(['plugin', '--profile', WEB_PROFILE, 'add', '--ignore-scripts', archive], { timeoutMs: 180_000 });
if (installed.code !== 0) throw new Error('ローカルプラグインの dsh 導入に失敗しました。');
await writeIsolationPatch(join(paths.work, 'web-isolation.patch.yml'), { webCredentials: true });
const verified = await runDsh(['--profile', WEB_PROFILE, '--dump-config'], { capture: true });
if (verified.code !== 0 || !verified.stdout.includes('dsh-siwc-bridge')) throw new Error('dsh profile にプラグインが見つかりません。');
if (!existsSync(archive)) throw new Error('導入アーカイブが見つかりません。');
const profileRequire = createRequire(join(paths.home, 'profiles', WEB_PROFILE, 'package.json'));
if (!existsSync(profileRequire.resolve('dsh-siwc-bridge/web-credentials'))) throw new Error('導入済みWeb資格情報プラグインが見つかりません。');
const comparison = await verifyInstalledPlugin(WEB_PROFILE);
if (comparison.mismatches.length) throw new Error(`導入済みプラグインが現ビルドと一致しません（${comparison.mismatches.length}件）。`);
console.log(`SETUP_OK: ${archive}\n開始: npm.cmd start\n削除: npm.cmd run remove:plugin`);
