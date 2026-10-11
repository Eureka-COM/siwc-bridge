import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_PROFILE = 'siwc-web';
export const MOCK_PROFILE = 'siwc-mock';
export const paths = Object.freeze({
  root, work: join(root, '.work'), home: join(root, '.work', 'dsh-home'),
  workspace: join(root, '.work', 'dummy-workspace'),
  guardFixture: join(root, 'tests', 'fixtures', 'guard.mjs'),
  mockFixture: join(root, 'tests', 'fixtures', 'mock-plugin.mjs'),
});

/** Read no credential values; remove inherited alternate-provider settings by name. */
export function cleanEnvironment(extra = {}, home = paths.home) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^(?:OPENAI|DEEPSEEK|CODEX|ANTHROPIC|CLAUDE|PI|SIWC|DSH)_(?:.*)$/i.test(name)
      || /(?:ACCESS_TOKEN|REFRESH_TOKEN|API_KEY|AUTH_TOKEN|BEARER_TOKEN)$/i.test(name)) {
      delete environment[name];
    }
  }
  // Permission mode is DSH's own setting (chosen in its UI); tests pass one explicitly.
  return { ...environment, ...extra, DSH_HOME: resolve(home), DSH_TELEMETRY_DISABLED: '1' };
}

export function resolveDshBin() {
  const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json');
  const binary = join(dirname(manifest), 'lib', 'bin.js');
  if (!existsSync(binary)) throw new Error('固定した dsh の built CLI がありません。npm.cmd ci --ignore-scripts を実行してください。');
  return binary;
}

export function resolveNpmCli() {
  const binary = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(binary)) throw new Error('npm CLI が見つかりません。npm.cmd からこのスクリプトを実行してください。');
  return binary;
}

/** Give each rebuilt local package its own content path so pnpm cannot reuse a same-version tarball. */
export async function verifiedArchive(archive) {
  const source = resolve(archive);
  const relativePath = relative(join(paths.work, 'packages'), source);
  if (isAbsolute(relativePath) || relativePath.startsWith('..') || !relativePath.endsWith('.tgz')) throw new Error('専用packages配下のローカルtgzだけを導入できます。');
  const digest = createHash('sha256').update(await readFile(source)).digest('hex');
  const target = join(dirname(source), basename(source, '.tgz') + '-' + digest + '.tgz');
  if (!existsSync(target)) await copyFile(source, target);
  const actual = createHash('sha256').update(await readFile(target)).digest('hex');
  if (actual !== digest) throw new Error('ローカル導入アーカイブの整合性を確認できません。');
  return target;
}

/** Compare installed executable artifacts with the current build without reading any user data. */
export async function verifyInstalledPlugin(profile, { home = paths.home } = {}) {
  const installed = createRequire(join(home, 'profiles', profile, 'package.json')).resolve('dsh-siwc-bridge');
  const installedRoot = resolve(dirname(installed), '..'); const artifacts = [];
  const collect = async folder => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.name.endsWith('.js')) artifacts.push(relative(paths.root, path));
    }
  };
  await collect(join(paths.root, 'lib')); artifacts.push(join('scripts', 'dpapi.ps1'));
  const mismatches = [];
  for (const file of artifacts) {
    const expected = createHash('sha256').update(await readFile(join(paths.root, file))).digest('hex');
    try {
      const actual = createHash('sha256').update(await readFile(join(installedRoot, file))).digest('hex');
      if (actual !== expected) mismatches.push(file);
    } catch (error) { if (error.code === 'ENOENT') mismatches.push(file); else throw error; }
  }
  return { files: artifacts.length, mismatches };
}

/** Launch a local process with bounded waiting and optional capture. No shell interpolation. */
export function runNode(binary, args, { cwd = paths.workspace, home = paths.home, env = {}, capture = false, timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      cwd, env: cleanEnvironment(env, home), windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const terminate = () => { child.kill(); };
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; terminate(); }, timeoutMs) : undefined;
    if (signal?.aborted) terminate();
    else signal?.addEventListener('abort', terminate, { once: true });
    child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
    const cleanup = () => { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', terminate); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, endSignal) => {
      cleanup();
      resolveResult({ code: code ?? 1, stdout, stderr, signal: endSignal, timedOut });
    });
  });
}

export function runDsh(args, options = {}) { return runNode(resolveDshBin(), args, options); }

export async function initializeProfile(name, template, { home = paths.home } = {}) {
  await mkdir(home, { recursive: true }); await mkdir(paths.workspace, { recursive: true });
  if (existsSync(join(home, 'profiles', name, 'package.json'))) return;
  const result = await runDsh(['--profile', name, '--from-default-profile', template, '--dump-config'], { home, capture: true });
  if (result.code !== 0) throw new Error(`dsh profile ${name} の初期化に失敗しました: ${result.stderr.trim()}`);
}

// DeepSeek-account features need a DeepSeek sign-in this home never has; telemetry is
// off, and titles come from the first prompt instead of an extra model request.
// Everything else stays DSH's default.
const disabledRows = ['session-title-llm', 'session-telemetry-otel', 'authorization', 'credentials', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'deepseek-account'];
const yaml = value => JSON.stringify(value);

/**
 * The only overlay this integration applies to DSH: disable the DeepSeek-account
 * pieces, keep Web sign-in keys in memory, use native tool calls (the ChatGPT-plan
 * route has no programmatic tool calling), and pick the default model.
 * `workspace`/`readOnly` are for automated tests only; normal use keeps DSH's own
 * workspace and permission choices.
 */
export async function writeRuntimePatch(file, { provider = 'siwc', model, guard, fixture, webCredentials = false,
  webCredentialsPath = 'dsh-siwc-bridge/web-credentials', printWebUrl = false, workspace, readOnly = false, effort } = {}) {
  let content = disabledRows.map(id => `- id: ${id}\n  disabled: true\n`).join('\n');
  if (webCredentials) {
    // Web Connection receives a process-only signing key, separate from SIWC OAuth credentials.
    content += `\n- insert:\n    - id: siwc-web-credentials\n      name: ${yaml(webCredentialsPath)}\n`;
    // A dsh patch replaces the whole config, so preserve its official CLI expressions.
    content += `\n- id: web-runtime\n  config:\n    openBrowser: !!js ctx.webStartup.openBrowser\n    printUrl: ${printWebUrl}\n`;
    content += '    publicUrl: !!js ctx.webStartup.publicUrl\n    surfaceContext: true\n    trustedHosts: !!js ctx.webStartup.trustedHosts\n';
  }
  if (workspace && readOnly) content += `\n- id: sandbox-policy\n  config:\n    mode: read-only\n    workspaceRoot: ${yaml(workspace)}\n`;
  if (workspace) content += '\n- id: fs-sandbox\n  config:\n    cwd: ' + yaml(workspace) + '\n';
  content += '\n- id: tools\n  config:\n    mode: native\n';
  if (model) content += `\n- id: agent-default-model\n  config:\n    provider: ${yaml(provider)}\n    model: ${yaml(model)}\n${effort ? `    reasoningEffort: ${yaml(effort)}\n` : ''}`;
  const inserted = [];
  if (guard) inserted.push({ id: 'siwc-test-guard', name: guard.path ?? paths.guardFixture, config: {
    dummyPath: guard.dummyPath, evidencePath: guard.evidencePath,
    toolLimit: guard.toolLimit ?? 1, maxSteps: guard.maxSteps ?? 2, timeoutMs: guard.timeoutMs ?? 60_000,
  } });
  if (fixture) {
    content += '\n- id: siwc-adapter\n  disabled: true\n';
    inserted.push({ id: 'siwc-mock-adapter', name: fixture.path ?? paths.mockFixture, config: {
      evidencePath: fixture.evidencePath, dummyPath: guard?.dummyPath,
      scenario: fixture.scenario ?? 'completed', model: model ?? 'siwc-mock-model', provider,
    } });
  }
  for (const row of inserted) {
    content += `\n- insert:\n    - id: ${row.id}\n      name: ${yaml(row.name)}\n      config:\n`;
    for (const [key, value] of Object.entries(row.config)) if (value !== undefined) content += `        ${key}: ${yaml(value)}\n`;
  }
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, content, 'utf8');
}
/** v0.2 name, used by tests: the read-only dummy workspace is kept there explicitly. */
export const writeIsolationPatch = (file, options = {}) => writeRuntimePatch(file, { workspace: paths.workspace, readOnly: true, ...options });

/**
 * Default model for a new start: the saved choice, else the first model of the
 * account catalog (saved, or fetched once). Retried, because a start right after
 * sign-in or another process's refresh can briefly find the store busy. The
 * reason is returned so the launcher can say why no default was set.
 */
export async function readSelectedModel(explicitModel) {
  if (explicitModel) return { model: explicitModel };
  let reason;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const [{ selectedModel }, { AuthManager }, { diskCatalogStore }, { createServices }] = await Promise.all([
        import('../lib/admin.js'), import('../lib/auth.js'), import('../lib/local-cache.js'), import('../lib/admin.js')]);
      const auth = new AuthManager();
      try {
        const saved = await selectedModel(auth);
        if (saved) return { model: saved };
        const status = await auth.status();
        if (!status.activeId) return { model: undefined, reason: 'not signed in yet' };
        const stored = await diskCatalogStore().load(status.activeId);
        if (stored?.length) return { model: stored[0].id };
        const { adapter } = createServices();
        const fresh = await adapter.listModelsFresh('siwc');
        if (fresh.length) return { model: fresh[0].id };
        return { model: undefined, reason: 'no model is listed for this account' };
      } finally { auth.abortAll(); }
    } catch (error) {
      reason = `could not read the sign-in state: ${error?.code ?? error?.name ?? 'error'}`;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
  return { model: undefined, reason };
}
