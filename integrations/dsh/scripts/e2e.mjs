// Real-account end-to-end checks through a headless DSH profile with the installed plugin.
// Uses the signed-in ChatGPT plan: every scenario sends real requests. Run only when intended:
//   node scripts/e2e.mjs [scenario ...]        (default: all: text tool continue switch pdf search effort multitool subagent long)
// Writes full run events to .work/e2e/<time>/ (test prompts only) and prints a summary.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeProfile, paths, runDsh, samplePdf, verifiedArchive, verifyInstalledPlugin, writeRuntimePatch, readSelectedModel } from './dsh-env.mjs';

const PROFILE = 'siwc-e2e';
const workspace = join(paths.work, 'e2e-workspace');
const runFolder = join(paths.work, 'e2e', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(workspace, { recursive: true }); await mkdir(runFolder, { recursive: true });

async function install() {
  await initializeProfile(PROFILE, 'headless');
  const packages = join(paths.work, 'packages');
  const candidates = (await readdir(packages)).filter(name => /^dsh-siwc-bridge-\d+\.\d+\.\d+\.tgz$/.test(name));
  if (!candidates.length) throw new Error('先に npm.cmd run setup を実行してください。');
  const newest = (await Promise.all(candidates.map(async name => ({ name, time: (await stat(join(packages, name))).mtimeMs })))).sort((a, b) => b.time - a.time)[0].name;
  const archive = await verifiedArchive(join(packages, newest));
  const listed = await runDsh(['--profile', PROFILE, '--dump-config'], { capture: true });
  if (listed.stdout.includes('name: dsh-siwc-bridge')) await runDsh(['plugin', '--profile', PROFILE, 'remove', 'dsh-siwc-bridge'], { capture: true, env: { npm_config_ignore_scripts: 'true' }, timeoutMs: 120_000 });
  const added = await runDsh(['plugin', '--profile', PROFILE, 'add', '--ignore-scripts', archive], { capture: true, timeoutMs: 180_000 });
  if (added.code !== 0) throw new Error('E2E profile への導入に失敗しました。');
  if ((await verifyInstalledPlugin(PROFILE)).mismatches.length) throw new Error('E2E profile のプラグインが現在のbuildと一致しません。');
}

async function turn(name, task, { model, effort, sessionId, timeoutMs = 300_000 } = {}) {
  const patch = join(runFolder, `${name}.patch.yml`);
  await writeRuntimePatch(patch, { model, effort, workspace, readOnly: true });
  const args = ['--profile', PROFILE, '--patch', patch, '--json', ...(sessionId ? ['--session-id', sessionId] : []), task];
  const started = Date.now();
  const result = await runDsh(args, { cwd: workspace, capture: true, timeoutMs });
  await writeFile(join(runFolder, `${name}.jsonl`), result.stdout, 'utf8');
  await writeFile(join(runFolder, `${name}.stderr.txt`), result.stderr, 'utf8');
  const rows = result.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const session = rows.find(row => row.type === 'session')?.sessionId;
  const final = rows.find(row => row.type === 'final')?.text ?? '';
  const end = rows.filter(row => row.phase === 'turn_end').at(-1)?.reason;
  return {
    name, exitCode: result.code, timedOut: result.timedOut, seconds: Math.round((Date.now() - started) / 100) / 10, session,
    turnEnd: end?.kind, failure: end?.failure ? `${end.failure.code}: ${String(end.failure.message).slice(0, 300)}` : undefined,
    tools: rows.filter(row => row.type === 'tool_call').map(row => row.tool), toolErrors: rows.filter(row => row.type === 'tool_result' && row.status === 'error').length,
    thinking: rows.some(row => row.type === 'thinking'), final,
    stderr: result.code ? result.stderr.split(/\r?\n/).filter(Boolean).slice(-4) : undefined,
  };
}

const marker = randomBytes(6).toString('hex');
const markerFile = join(workspace, 'marker.txt');
await writeFile(markerFile, `value: ${marker}\n`, 'utf8');
const numbers = [17, 42, 8, 99, 34];
for (const [index, value] of numbers.entries()) await writeFile(join(workspace, `n${index + 1}.txt`), `number=${value}\n`, 'utf8');

const { model } = await readSelectedModel();
if (!model) throw new Error('モデルが未設定です。node lib/cli.js model <slug> で既定モデルを選んでください。');
const { diskCatalogStore } = await import('../lib/local-cache.js');
const { AuthManager } = await import('../lib/auth.js');
const activeId = (await new AuthManager().status()).activeId;
const catalog = activeId ? await diskCatalogStore().load(activeId) : undefined;
const otherModel = catalog?.find(entry => entry.id !== model)?.id;

const selected = new Set(process.argv.slice(2));
const want = name => selected.size === 0 || selected.has(name);
const results = [];
const check = (result, ok, detail) => { result.pass = ok; if (detail) result.detail = detail; results.push(result); console.log(JSON.stringify({ ...result, final: result.final.slice(-200) })); };

await install();
if (want('text')) { const r = await turn('text', '日本語で「動作確認OK」とだけ返してください。', { model }); check(r, r.exitCode === 0 && r.final.includes('動作確認OK')); }
let toolSession;
if (want('tool') || want('continue') || want('switch')) {
  const r = await turn('tool', `ファイル ${markerFile} を読み、書かれている value の値だけを返してください。`, { model });
  toolSession = r.session; check(r, r.exitCode === 0 && r.final.includes(marker) && r.tools.length > 0);
}
if (want('continue') && toolSession) {
  const r = await turn('continue', 'さっき読んだ値を、1文字ずつ逆順に並べた文字列だけを返してください。', { model, sessionId: toolSession });
  check(r, r.exitCode === 0 && r.final.includes([...marker].reverse().join('')));
}
if (want('switch') && toolSession && otherModel) {
  const r = await turn('switch', 'この会話で読んだファイルの value の値をもう一度だけ返してください。', { model: otherModel, sessionId: toolSession });
  check(r, r.exitCode === 0 && r.final.includes(marker), `model=${otherModel}`);
}
if (want('pdf')) {
  // A PDF in the workspace: DSH's read cannot decode it; read_pdf gives the document to the model.
  const word = `QUINCE-${randomBytes(3).toString('hex').toUpperCase()}`;
  const file = join(workspace, 'notice.pdf');
  await writeFile(file, samplePdf(`The code word is ${word}.`));
  const r = await turn('pdf', `${file} のPDFに書かれている code word だけを返してください。`, { model });
  check(r, r.exitCode === 0 && r.tools.includes('read_pdf') && r.final.includes(word));
}
if (want('search')) {
  // DSH's own web_search tool, answered through the ChatGPT plan (no DeepSeek key).
  const r = await turn('search', 'web_search ツールで Node.js 24 LTS のコードネームを調べ、コードネームと、根拠にしたページのURLを1つだけ答えてください。', { model });
  check(r, r.exitCode === 0 && r.tools.includes('web_search') && r.toolErrors === 0 && /krypton/i.test(r.final) && /https?:\/\//.test(r.final));
}
if (want('effort')) { const r = await turn('effort', '1から100までの素数はいくつありますか。数字だけで答えてください。', { model, effort: 'max' }); check(r, r.exitCode === 0 && /25/.test(r.final)); }
if (want('multitool')) {
  const r = await turn('multitool', `${workspace} にある n1.txt から n5.txt を全部読み、number の合計を数字だけで答えてください。`, { model, effort: 'high' });
  check(r, r.exitCode === 0 && r.final.includes(String(numbers.reduce((a, b) => a + b, 0))) && r.tools.length >= 1);
}
if (want('subagent')) {
  const r = await turn('subagent', `サブエージェント（タスク委任のツール）を1回使って ${markerFile} を読ませ、その value の値だけを返してください。委任のツールがない場合は自分で読んでください。`, { model });
  check(r, r.exitCode === 0 && r.final.includes(marker));
}
if (want('long')) {
  const r = await turn('long', `${workspace} のファイルをすべて読んでから、それぞれの内容を表にまとめ、最後に number の最大値と最小値を答えてください。`, { model, effort: 'max', timeoutMs: 600_000 });
  check(r, r.exitCode === 0 && r.final.includes('99') && r.final.includes('8'));
}
const { diskDiagnostics } = await import('../lib/diagnostics.js');
const diagnostics = await diskDiagnostics().tail(30);
await writeFile(join(runFolder, 'summary.json'), JSON.stringify({ model, otherModel, results }, null, 2), 'utf8');
console.log(JSON.stringify({ summary: `${results.filter(r => r.pass).length}/${results.length} passed`, folder: runFolder }));
console.log('--- diagnostics (labels only) ---'); for (const line of diagnostics) console.log(line);
if (results.some(r => !r.pass)) process.exitCode = 1;
if (!existsSync(markerFile)) process.exitCode = 1;
