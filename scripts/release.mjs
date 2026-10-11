import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hasSecretCandidate, isPrivatePath } from './publication-safety.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(root, 'artifacts');
const checkOnly = process.argv.includes('--check-only');
const singles = ['package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', 'LICENSE', 'NOTICE', 'README.md'];
const files = [...singles];
const excluded = new Set(['node_modules', '.work', '.git', 'artifacts', 'lib']);
async function enumerate(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const file = join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error('公開候補にsymlinkを含めません。');
    if (entry.isDirectory()) await enumerate(file);
    else files.push(relative(root, file).replaceAll('\\', '/'));
  }
}
for (const folder of ['src', 'tests', 'scripts', 'docs', 'examples', '.github', 'integrations']) await enumerate(join(root, folder));
files.sort();
const personal = /\b[A-Za-z]:[\\/]+|\bfile:[\\/]{2,}|(?:^|[\s"'`(=:])(?:\\{2,}(?:[?.][\\/]+UNC[\\/]+)?[\p{L}\p{N}][\p{L}\p{N}._-]*[\\/]+[^\\/\s"'`<>|:*?()[\]{}]+|\/(?:home|Users)\/[^/\s"'`<>|]+)/iu;
const inventory = [];
for (const file of files) {
  if (isPrivatePath(file) || /(^|\/)lib(\/|$)/.test(file)) throw new Error('個人状態または生成物を検出しました。');
  const content = await readFile(join(root, file));
  if (hasSecretCandidate(content.toString('utf8')) || personal.test(content.toString('utf8'))) throw new Error('秘密情報候補または個人PCパスを検出しました。内容は表示しません。');
  inventory.push({ file, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
}
await mkdir(destination, { recursive: true });
const manifest = join(destination, 'source-manifest.json');
if (!checkOnly) await writeFile(manifest, JSON.stringify(inventory, null, 2) + '\n');
const zip = join(destination, 'siwc-bridge-0.2.1-source.zip');
if (!checkOnly) await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression; $rows=Get-Content -LiteralPath $env:SIWC_RELEASE_MANIFEST -Encoding UTF8 | ConvertFrom-Json; $f=[IO.File]::Open($env:SIWC_RELEASE_ZIP,[IO.FileMode]::Create); $z=New-Object IO.Compression.ZipArchive($f,[IO.Compression.ZipArchiveMode]::Create,$false); try { foreach($r in $rows) { $e=$z.CreateEntry($r.file,[IO.Compression.CompressionLevel]::Optimal); $e.LastWriteTime=[DateTimeOffset]::Parse("1980-01-01T00:00:00+00:00"); $s=$e.Open(); try { $b=[IO.File]::ReadAllBytes([IO.Path]::Combine($env:SIWC_RELEASE_ROOT,$r.file)); $s.Write($b,0,$b.Length) } finally { $s.Dispose() } } } finally { $z.Dispose(); $f.Dispose() }'],
  { windowsHide: true, env: { ...process.env, SIWC_RELEASE_MANIFEST: manifest, SIWC_RELEASE_ZIP: zip, SIWC_RELEASE_ROOT: root } });
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const packed = await promisify(execFile)(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', ...(checkOnly ? ['--dry-run'] : []), '--pack-destination', destination], { cwd: root, windowsHide: true });
const info = JSON.parse(packed.stdout)[0];
for (const row of info.files) {
  if (!/^(lib\/|scripts\/dpapi\.ps1$|docs\/|README\.md$|NOTICE$|LICENSE$|package\.json$)/.test(row.path)) throw new Error('予期しないnpm配布内容です。');
  const bytes = await readFile(join(root, row.path));
  if (isPrivatePath(row.path) || hasSecretCandidate(bytes.toString('utf8')) || personal.test(bytes.toString('utf8'))) throw new Error('npm候補に秘密情報または個人パスがあります。');
}
if (!checkOnly) await writeFile(join(destination, 'package-manifest.json'), JSON.stringify(info.files, null, 2) + '\n');
const archives = [zip, join(destination, info.filename)];
if (!checkOnly) await writeFile(join(destination, 'SHA256SUMS.txt'), (await Promise.all(archives.map(async file => `${createHash('sha256').update(await readFile(file)).digest('hex')}  ${relative(destination, file)}`))).join('\n') + '\n');
console.log(JSON.stringify({ kind: checkOnly ? 'checked-only' : 'local-only', sourceFiles: inventory.length, npmFiles: info.files.length, dependencyCount: 1, credentialCandidates: 0, personalPathCandidates: 0, pathScanRule: 'fixed-local-path-v1', pathScanScope: 'current-source-and-npm-candidates', gitHistoryScanned: false }));
