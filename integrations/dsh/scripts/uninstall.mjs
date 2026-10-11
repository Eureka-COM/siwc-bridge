import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths, runDsh, WEB_PROFILE } from './dsh-env.mjs';

if (process.argv.slice(2).length) throw new Error('この削除操作はプラグイン登録だけを解除します。認証状態やファイルの削除は本人が対象を確認して行ってください。');
for (const profile of [WEB_PROFILE, 'siwc-live', 'siwc-e2e']) {
  if (!existsSync(join(paths.home, 'profiles', profile, 'package.json'))) {
    console.log(`UNINSTALL_OK: ${profile} は未導入です。`);
    continue;
  }
  const before = await runDsh(['--profile', profile, '--dump-config'], { capture: true });
  if (before.code !== 0) throw new Error(`${profile} の登録確認に失敗しました。`);
  if (!before.stdout.includes('name: dsh-siwc-bridge')) {
    console.log(`UNINSTALL_OK: ${profile} にプラグイン登録はありません。`);
    continue;
  }
  const result = await runDsh(['plugin', '--profile', profile, 'remove', 'dsh-siwc-bridge'], { env: { npm_config_ignore_scripts: 'true' }, timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(`${profile} のプラグイン登録解除に失敗しました。`);
  const check = await runDsh(['--profile', profile, '--dump-config'], { capture: true });
  if (check.code !== 0 || check.stdout.includes('name: dsh-siwc-bridge')) throw new Error(`${profile} のプラグイン登録解除の検証に失敗しました。`);
  console.log(`UNINSTALL_OK: ${profile} のプラグイン登録を解除しました。`);
}
console.log('profile・認証状態・生成物は保存しています。');
