import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createServices, MANAGE_USAGE, selectedModel } from '../lib/admin.js';
import { armVerification, verificationStatus } from '../lib/ledger.js';
import { paths, initializeProfile, writeIsolationPatch, runDsh, verifiedArchive, verifyInstalledPlugin } from './dsh-env.mjs';

const args = process.argv.slice(2);
if (!args.includes('--begin')) {
  console.log('ライブテストはOFF。本人ログイン→confirm→models→model <slug>後に、npm.cmd run live-test -- --begin で明示開始します。');
  console.log(`本人確認先: ${MANAGE_USAGE}（アプリ上限100%未満またはクレジット利用OFFを保存・確認。自動購入OFFだけでは既存クレジット消費を防げません）`);
  console.log('初期予算: 合計6推論HTTP要求、同一scenario 2ステップ・read1回・60秒。既定の自動再試行0回。');
  process.exit(0);
}
if (!stdin.isTTY && !(args.includes('--settings-confirmed') && args.includes('--plan-only-confirmed'))) throw new Error('本人による開始とクレジット不使用設定の保存確認が必要です。対話ターミナルで実行してください。');
if (!(args.includes('--settings-confirmed') && args.includes('--plan-only-confirmed'))) {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(`本人が ${MANAGE_USAGE} でアプリ週間上限を100%未満、またはアプリのクレジット利用をOFFに保存・確認し、サブスクリプション枠で最大6要求のライブ検証を開始する場合は START と入力してください: `);
    if (answer !== 'START') { console.log('開始していません。'); process.exit(0); }
  } finally { prompt.close(); }
}
const { auth, adapter } = createServices();
const state = await auth.status();
const registration = state.registrations.find(r => r.active);
if (!registration?.authenticated || !registration.planAllowed || !registration.planConfirmed) throw new Error('公式ログイン・プラン利用許可・初回確認を完了してください。推論0件。');
const model = await selectedModel(auth);
if (!model) throw new Error('認証済みのアカウントからモデルを選択してください。推論0件。');
await adapter.resolveModel('siwc', model);
const current = await verificationStatus();
if (current.inference > 4) throw new Error(`残る検証予算では2要求のtool往復を開始できません（使用${current.inference}/6）。`);
await armVerification();
await initializeProfile('siwc-live', 'headless');
const sourceArchive = join(paths.work, 'packages', 'dsh-siwc-bridge-0.2.1.tgz');
if (!existsSync(sourceArchive)) throw new Error('先に npm.cmd run setup を実行してください。推論0件。');
const archive = await verifiedArchive(sourceArchive);
const installed = await runDsh(['plugin', '--profile', 'siwc-live', 'add', '--ignore-scripts', archive], { capture: true, timeoutMs: 180_000 });
if (installed.code !== 0) throw new Error('ライブ専用profileへの導入に失敗しました。推論0件。');
if ((await verifyInstalledPlugin('siwc-live')).mismatches.length) throw new Error('ライブ専用profileのコードが現在のbuildと一致しません。推論を開始しません。setupを再実行してください。');
const evidence = join(paths.work, 'verification', 'live-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(evidence, { recursive: true });
await mkdir(paths.workspace, { recursive: true });
const dummyPath = join(paths.workspace, 'siwc-dummy.txt');
// Marker never appears in the model prompt; the existing read tool must discover it.
const marker = randomBytes(12).toString('hex');
await writeFile(dummyPath, `SIWC dummy value: ${marker}\n`, 'utf8');
const patch = join(evidence, 'live.patch.yml');
await writeIsolationPatch(patch, { model, guard: { dummyPath, evidencePath: join(evidence, 'guard.json'), toolLimit: 1, maxSteps: 2, timeoutMs: 60_000 } });
// Use the installed production plugin, with its own protected SIWC credentials.
const task = `readツールで ${dummyPath} を1回だけ読み、そこに記載されたdummy valueを最終回答で返してください。他のファイルやツールは使わないでください。`;
const result = await runDsh(['--profile', 'siwc-live', '--patch', patch, '--json', task], { capture: true, timeoutMs: 75_000 });
await writeFile(join(evidence, 'dsh.jsonl'), result.stdout, 'utf8');
await writeFile(join(evidence, 'stderr.txt'), result.stderr, 'utf8');
const guard = JSON.parse(await readFile(join(evidence, 'guard.json'), 'utf8'));
const lines = result.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const texts = lines.filter(row => row.type === 'text').map(row => row.text ?? row.delta ?? '').join('');
const counts = await verificationStatus();
const call = lines.find(row => row.type === 'tool_call');
const toolResult = lines.find(row => row.type === 'tool_result');
const final = lines.find(row => row.type === 'final');
const toolPassed = result.code === 0 && guard.allowedCalls?.length === 1 && guard.results?.length === 1 && !guard.results[0].isError
  && call?.callId === toolResult?.callId && toolResult?.result?.includes(marker) && final?.text?.includes(marker)
  && lines.some(row => row.phase === 'turn_end' && row.reason?.kind === 'completed');
const report = { kind: 'live', toolRoundtrip: toolPassed ? 'PASS' : 'FAIL', exitCode: result.code, requests: counts, toolCalls: guard.allowedCalls.length, resultSha256: createHash('sha256').update(texts).digest('hex'), usageAccounting: 'NOT_VERIFIED', creditSettings: 'USER_CONFIRMED_PLAN_ONLY' };
await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log('証跡は .work/verification 配下。公式画面での計上確認は別途必要です。');
auth.abortAll(); adapter.cancelRequests();
process.exitCode = toolPassed ? 0 : 1;
