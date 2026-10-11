import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { cleanEnvironment, initializeProfile, paths, resolveDshBin, runDsh, writeIsolationPatch } from '../scripts/dsh-env.mjs';

for (const scenario of ['completed', 'disconnected']) {
  test(`実 dsh の SIWC モック ${scenario}: ローカル read と終端判定`, { timeout: 120_000 }, async () => {
    const runId = randomBytes(6).toString('hex'); const folder = join(paths.work, 'verification', `mock-${scenario}-${runId}`);
    await mkdir(folder, { recursive: true }); await mkdir(paths.workspace, { recursive: true });
    const marker = `DSH_MOCK_VALUE=${randomBytes(16).toString('hex')}`;
    const dummyPath = join(paths.workspace, `${runId}.txt`); await writeFile(dummyPath, marker + '\n', 'utf8');
    const home = join(folder, 'dsh-home'); const profile = 'siwc-mock';
    await initializeProfile(profile, 'headless', { home });
    const guardEvidence = join(folder, 'guard.json'); const modelEvidence = join(folder, 'requests.json');
    const patch = join(folder, 'mock.patch.yml');
    await writeIsolationPatch(patch, { provider: 'siwc', model: 'siwc-mock-model',
      guard: { dummyPath, evidencePath: guardEvidence, timeoutMs: 45_000 },
      fixture: { evidencePath: modelEvidence, scenario } });
    const result = await runDsh(['--profile', profile, '--patch', patch, '--json', `Use the read tool once to inspect ${dummyPath}. Answer only with the marker found in that file.`], {
      home, capture: true, timeoutMs: 75_000,
    });
    await writeFile(join(folder, 'stdout.jsonl'), result.stdout, 'utf8'); await writeFile(join(folder, 'stderr.txt'), result.stderr, 'utf8');
    assert.equal(result.timedOut, false, `dsh exceeded the local timeout; evidence: ${folder}`);
    let guards;
    try { guards = JSON.parse(await readFile(guardEvidence, 'utf8')); }
    catch (error) { assert.fail(`dsh could not boot the guard; evidence: ${folder}\n${result.stderr}\n${error.message}`); }
    const requests = JSON.parse(await readFile(modelEvidence, 'utf8'));
    const events = result.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.ok(requests.requests.every(request => request.attribution), 'provider attribution missing');
    assert.equal(requests.requests[0].body.store, false); assert.equal(requests.requests[0].body.stream, true);
    assert.ok(!JSON.stringify(requests.requests[0].body.input).includes(marker), 'marker leaked into initial prompt');
    if (scenario === 'completed') {
      assert.equal(result.code, 0, `dsh failed; evidence: ${folder}\n${result.stderr}`);
      assert.equal(requests.inferenceRequests, 2); assert.equal(guards.allowedCalls.length, 1); assert.equal(guards.results.length, 1);
      assert.equal(guards.results[0].isError, false); assert.equal(guards.denied, 0);
      const resultEvent = events.find(event => event.type === 'tool_result');
      assert.equal(resultEvent?.callId, 'call_fixture'); assert.match(resultEvent.result, new RegExp(marker));
      const second = requests.requests[1].body.input;
      assert.ok(second.some(item => item.type === 'function_call' && item.call_id === 'call_fixture'));
      assert.ok(second.some(item => item.type === 'function_call_output' && item.call_id === 'call_fixture' && JSON.stringify(item.output).includes(marker)));
      assert.ok(events.some(event => event.type === 'final' && event.text.includes(marker)));
      assert.ok(events.some(event => event.phase === 'turn_end' && event.reason?.kind === 'completed'));
    } else {
      assert.notEqual(result.code, 0); assert.equal(requests.inferenceRequests, 1);
      assert.equal(guards.allowedCalls.length, 0); assert.equal(guards.results.length, 0);
      assert.equal(events.filter(event => event.type === 'tool_call').length, 0);
    }
    console.log(`DSH_MOCK_EVIDENCE: ${folder}`);
  });
}

function loopbackGet(url, headers = {}) {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const request = get(url, { headers }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.once('error', reject);
    });
    request.setTimeout(2_000, () => request.destroy(new Error('Loopback response deadline exceeded.')));
    request.once('error', reject);
  });
}

function launchWeb(profile, patch, home, port = '0') {
  const child = spawn(process.execPath, [resolveDshBin(), '--profile', profile, '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', port], {
    cwd: paths.workspace, env: cleanEnvironment({}, home), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Fresh process tokens are captured only in memory, never in logs or artifacts.
  let stdout = ''; let failed = false; let exited = false;
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { failed ||= chunk.toString('utf8').includes('startup failed'); });
  const closed = new Promise(resolve => { child.once('error', () => { failed = true; }); child.once('close', () => { exited = true; resolve(); }); });
  return {
    async ready() {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !exited) {
        const ready = stdout.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/?\?token=[A-Za-z0-9_-]+)/)?.[1];
        if (ready && !failed) return ready;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Web startup failed or exceeded deadline. No private output is included.');
    },
    async stop() { if (!exited) child.kill(); await closed; stdout = ''; },
  };
}

test('実 dsh Web: メモリ専用資格情報で localhost HTML を提供し平文を保存しない', { timeout: 45_000 }, async () => {
  const folder = join(paths.work, 'verification', `web-${randomBytes(6).toString('hex')}`);
  const home = join(folder, 'dsh-home'); const profile = 'siwc-web-test';
  await mkdir(folder, { recursive: true }); await initializeProfile(profile, 'web', { home });
  const patch = join(folder, 'web.patch.yml'); const modelEvidence = join(folder, 'requests.json');
  await writeIsolationPatch(patch, { webCredentials: true, webCredentialsPath: join(paths.root, 'lib', 'web-credentials.js'),
    printWebUrl: true, model: 'siwc-mock-model', fixture: { evidencePath: modelEvidence } });
  assert.equal(existsSync(join(home, '.credentials.yaml')), false, 'regression must start with no existing Web credentials');
  let server = launchWeb(profile, patch, home);
  try {
    const ready = await server.ready();
    const origin = new URL(ready).origin;
    const unauthenticated = await loopbackGet(origin + '/'); assert.equal(unauthenticated.status, 401);
    const exchange = await loopbackGet(ready); assert.equal(exchange.status, 303);
    const cookies = exchange.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ');
    assert.ok(cookies, 'fresh Web authentication did not issue a cookie');
    const authenticated = await loopbackGet(origin + '/', { cookie: cookies });
    assert.equal(authenticated.status, 200); assert.match(authenticated.body, /<!doctype html/i);
    assert.equal(existsSync(join(home, '.credentials.yaml')), false);
    const modelFacts = JSON.parse(await readFile(modelEvidence, 'utf8')); assert.equal(modelFacts.inferenceRequests, 0);
    await server.stop(); server = launchWeb(profile, patch, home, new URL(ready).port);
    const restartedUrl = await server.ready();
    const oldCookie = await loopbackGet(origin + '/', { cookie: cookies }); assert.equal(oldCookie.status, 401);
    const newExchange = await loopbackGet(restartedUrl); assert.equal(newExchange.status, 303);
    assert.equal(existsSync(join(home, '.credentials.yaml')), false);
    await writeFile(join(folder, 'result.json'), JSON.stringify({ kind: 'web-mock', unauthenticatedStatus: 401, exchangeStatus: 303,
      authenticatedStatus: 200, credentialsFileCreated: false, restartCookieStatus: 401,
      inferenceRequests: 0, startupError: false }, null, 2) + '\n', 'utf8');
    console.log(`DSH_WEB_EVIDENCE: ${folder}`);
  } finally { await server.stop(); }
});
