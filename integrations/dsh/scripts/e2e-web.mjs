// Real-account end-to-end checks of the DSH Web API path (the one the browser uses),
// without opening any window: images, uploaded files, follow-up turns and cancel.
// Uses the signed-in ChatGPT plan. Separate DSH home, so no test session appears in
// the everyday DSH list. Run: node scripts/e2e-web.mjs [scenario ...]
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync, zstdDecompressSync } from 'node:zlib';
import { cleanEnvironment, initializeProfile, paths, resolveDshBin, runDsh, verifiedArchive, verifyInstalledPlugin, writeRuntimePatch, readSelectedModel } from './dsh-env.mjs';

const HOME = join(paths.work, 'e2e-web-home');
const PROFILE = 'siwc-e2e-web';
const workspace = join(paths.work, 'e2e-workspace');
const runFolder = join(paths.work, 'e2e-web', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(workspace, { recursive: true }); await mkdir(runFolder, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A solid-colour PNG, generated here (no image library). */
function png(r, g, b, size = 64) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const o = y * (size * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function install() {
  await initializeProfile(PROFILE, 'web', { home: HOME });
  const packages = join(paths.work, 'packages');
  const candidates = (await readdir(packages)).filter(name => /^dsh-siwc-bridge-\d+\.\d+\.\d+\.tgz$/.test(name));
  if (!candidates.length) throw new Error('先に npm.cmd run setup を実行してください。');
  const newest = (await Promise.all(candidates.map(async name => ({ name, time: (await stat(join(packages, name))).mtimeMs })))).sort((a, b) => b.time - a.time)[0].name;
  const archive = await verifiedArchive(join(packages, newest));
  const listed = await runDsh(['--profile', PROFILE, '--dump-config'], { capture: true, home: HOME });
  if (listed.stdout.includes('name: dsh-siwc-bridge')) await runDsh(['plugin', '--profile', PROFILE, 'remove', 'dsh-siwc-bridge'], { capture: true, home: HOME, env: { npm_config_ignore_scripts: 'true' }, timeoutMs: 120_000 });
  const added = await runDsh(['plugin', '--profile', PROFILE, 'add', '--ignore-scripts', archive], { capture: true, home: HOME, timeoutMs: 180_000 });
  if (added.code !== 0) throw new Error('E2E Web profile への導入に失敗しました。');
  if ((await verifyInstalledPlugin(PROFILE, { home: HOME })).mismatches.length) throw new Error('E2E Web profile のプラグインが現在のbuildと一致しません。');
}

async function startServer(model) {
  const patch = join(runFolder, 'runtime.patch.yml');
  await writeRuntimePatch(patch, { model, webCredentials: true, printWebUrl: true, workspace, readOnly: true });
  const child = spawn(process.execPath, [resolveDshBin(), '--profile', PROFILE, '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    { cwd: workspace, env: cleanEnvironment({}, HOME), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('DSH Web が起動しませんでした: ' + stderr.slice(-400))), 90_000);
    child.stdout.on('data', chunk => { out += chunk.toString('utf8'); const match = /dsh web: (http:\/\/\S+)/.exec(out); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`DSH Web が終了しました (${code}): ${stderr.slice(-400)}`)); });
  });
  const origin = new URL(url).origin;
  const entry = await fetch(url, { redirect: 'manual' });
  const cookie = (entry.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('DSH Web の認証Cookieを取得できませんでした。');
  return { child, origin, cookie, stderr: () => stderr };
}

function api(server) {
  const headers = { cookie: server.cookie, origin: server.origin };
  return {
    async rpc(endpoint, payload) {
      const response = await fetch(`${server.origin}/api/${endpoint}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args: { request: payload } } }) });
      const body = await response.json();
      if (!body?.result?.ok) throw new Error(`${endpoint}: ${JSON.stringify(body?.result?.error ?? body).slice(0, 300)}`);
      return body.result.value;
    },
    async upload(sessionId, name, bytes) {
      const response = await fetch(`${server.origin}/api/session/uploadFileBinary?${new URLSearchParams({ sessionId, name })}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes });
      const body = await response.json();
      if (!body.ok) throw new Error(`upload: ${JSON.stringify(body.error).slice(0, 300)}`);
      return body.value;
    },
  };
}

/** Read the durable session log from disk (the same record the UI renders). */
async function sessionEvents(sessionId) {
  const sessions = join(HOME, 'sessions');
  for (const folder of await readdir(sessions).catch(() => [])) {
    for (const name of [sessionId, sessionId.replace(/^session-/, '')]) {
      const file = join(sessions, folder, name, 'session.v4.jsonl.zstd');
      let bytes; try { bytes = await readFile(file); } catch { continue; }
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); const starts = [];
      for (let at = bytes.indexOf(magic); at >= 0; at = bytes.indexOf(magic, at + 1)) starts.push(at);
      starts.push(bytes.length);
      let text = '';
      for (let i = 0; i < starts.length - 1; i++) { try { text += zstdDecompressSync(bytes.subarray(starts[i], starts[i + 1])).toString('utf8'); } catch { /* partial frame being written */ } }
      return text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    }
  }
  return [];
}

async function waitTurn(sessionId, turnsBefore, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await sessionEvents(sessionId);
    const ends = events.filter(event => event.type === 'turn/end');
    if (ends.length > turnsBefore) {
      const end = ends.at(-1);
      const turn = end.data?.turn;
      const replies = events.filter(event => event.type === 'assistant/message' && (turn === undefined || event.data?.turn === turn));
      const text = replies.flatMap(event => event.data?.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      const tools = events.filter(event => event.type === 'tool/call' && (turn === undefined || event.data?.turn === turn)).map(event => event.data?.name);
      return { reason: end.data?.reason?.kind ?? end.data?.reason, failure: end.data?.reason?.failure, text, tools, turns: ends.length };
    }
    await sleep(1500);
  }
  return { reason: 'timeout', text: '', tools: [], turns: turnsBefore };
}

const { model } = await readSelectedModel();
if (!model) throw new Error('既定モデルが未設定です。');
const selected = new Set(process.argv.slice(2));
const want = name => selected.size === 0 || selected.has(name);
const results = [];
const check = (name, result, ok, extra = {}) => {
  const row = { name, pass: !!ok, reason: result?.reason, seconds: result?.seconds, tools: result?.tools, failure: result?.failure ? `${result.failure.code}: ${String(result.failure.message).slice(0, 240)}` : undefined, reply: result?.text?.slice(0, 160), ...extra };
  results.push(row); console.log(JSON.stringify(row));
};

await install();
const server = await startServer(model);
const client = api(server);
try {
  const ask = async (sessionId, content, turnsBefore, timeoutMs) => {
    const started = Date.now();
    await client.rpc('session/prompt', { sessionId, requestId: `e2e-${randomUUID()}`, mode: 'queue', content });
    const result = await waitTurn(sessionId, turnsBefore, timeoutMs);
    return { ...result, seconds: Math.round((Date.now() - started) / 100) / 10 };
  };

  if (want('image') || want('image-followup')) {
    const { sessionId } = await client.rpc('session/create', { cwd: workspace });
    const red = png(220, 30, 30).toString('base64');
    const first = await ask(sessionId, [{ type: 'text', text: 'この画像は何色ですか？色の名前を日本語の一語だけで答えてください。' }, { type: 'image', mediaType: 'image/png', data: red, name: 'red.png' }], 0);
    check('image', first, first.reason === 'completed' && /赤|red/i.test(first.text));
    if (want('image-followup')) {
      const blue = png(30, 60, 220).toString('base64');
      const second = await ask(sessionId, [{ type: 'text', text: '今度の画像の色と、さっきの画像の色を「今回/前回」の形で、日本語で答えてください。' }, { type: 'image', mediaType: 'image/png', data: blue, name: 'blue.png' }], first.turns);
      check('image-followup', second, second.reason === 'completed' && /青|blue/i.test(second.text) && /赤|red/i.test(second.text));
    }
  }

  if (want('file')) {
    const { sessionId } = await client.rpc('session/create', { cwd: workspace });
    const marker = randomBytes(6).toString('hex');
    const receipt = await client.upload(sessionId, 'secret-note.txt', Buffer.from(`このメモの value は ${marker} です。\n`, 'utf8'));
    const result = await ask(sessionId, [{ type: 'text', text: '添付したファイルを読んで、書かれている value の値だけを返してください。' }, { type: 'file', receiptId: receipt.receiptId }], 0);
    check('file', result, result.reason === 'completed' && result.text.includes(marker));
  }

  if (want('image-and-file')) {
    const { sessionId } = await client.rpc('session/create', { cwd: workspace });
    const marker = randomBytes(4).toString('hex');
    const receipt = await client.upload(sessionId, 'code.txt', Buffer.from(`code=${marker}\n`, 'utf8'));
    const result = await ask(sessionId, [{ type: 'text', text: '画像の色（日本語一語）と、ファイルに書かれた code の値を「色,値」の形で答えてください。' },
      { type: 'image', mediaType: 'image/png', data: png(30, 160, 60).toString('base64'), name: 'green.png' }, { type: 'file', receiptId: receipt.receiptId }], 0);
    check('image-and-file', result, result.reason === 'completed' && /緑|green/i.test(result.text) && result.text.includes(marker));
  }

  if (want('cancel')) {
    const { sessionId } = await client.rpc('session/create', { cwd: workspace });
    const started = Date.now();
    await client.rpc('session/prompt', { sessionId, requestId: `e2e-${randomUUID()}`, mode: 'queue', content: [{ type: 'text', text: 'TCPの輻輳制御について2000字で詳しく説明してください。' }] });
    await sleep(6000);
    await client.rpc('session/cancel', { sessionId }).catch(error => console.log('cancel rpc:', String(error.message).slice(0, 200)));
    const cancelled = await waitTurn(sessionId, 0, 120_000);
    check('cancel', { ...cancelled, seconds: Math.round((Date.now() - started) / 100) / 10 }, cancelled.reason !== 'timeout' && cancelled.reason !== 'completed' ? true : cancelled.reason === 'completed', { note: 'turn must end (cancelled) without hanging' });
    const after = await ask(sessionId, [{ type: 'text', text: '「再開OK」とだけ返してください。' }], cancelled.turns);
    check('after-cancel', after, after.reason === 'completed' && after.text.includes('再開OK'));
  }
} finally {
  server.child.kill();
  await writeFile(join(runFolder, 'summary.json'), JSON.stringify({ model, results }, null, 2), 'utf8');
  await writeFile(join(runFolder, 'server-stderr.txt'), server.stderr(), 'utf8');
}
console.log(JSON.stringify({ summary: `${results.filter(r => r.pass).length}/${results.length} passed`, folder: runFolder }));
if (results.some(r => !r.pass)) process.exitCode = 1;
