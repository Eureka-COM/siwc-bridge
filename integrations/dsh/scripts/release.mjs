import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths, runNode, resolveNpmCli } from './dsh-env.mjs';
import { hasSecretCandidate, isPrivatePath } from './publication-safety.mjs';

/** The OS PowerShell by absolute path; never resolved through the working directory or PATH. */
function systemPowerShell() {
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root) || root.startsWith('\\\\')) throw new Error('WindowsのシステムPowerShellを確認できません。');
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
const destination = join(paths.root, 'artifacts');
const checkOnly = process.argv.includes('--check-only');
await mkdir(destination, { recursive: true });
const roots = ['src', 'tests', 'scripts', 'docs'];
const singles = ['package.json', 'package-lock.json', 'tsconfig.json', 'cordis.patch.yml', '.gitignore', 'LICENSE', 'NOTICE', 'README.md'];
const files = [...singles];
async function enumerate(folder) { for (const entry of await readdir(folder, { withFileTypes: true })) {
  const file = join(folder, entry.name);
  if (entry.isSymbolicLink()) throw new Error('公開候補にsymlinkを含めません。');
  if (entry.isDirectory()) await enumerate(file); else files.push(relative(paths.root, file).replaceAll('\\', '/'));
} }
for (const root of roots) await enumerate(join(paths.root, root));
files.sort();
const personal = /\b[A-Za-z]:[\\/]+|\bfile:[\\/]{2,}|(?:^|[\s"'`(=:])(?:\\{2,}(?:[?.][\\/]+UNC[\\/]+)?[\p{L}\p{N}][\p{L}\p{N}._-]*[\\/]+[^\\/\s"'`<>|:*?()[\]{}]+|\/(?:home|Users)\/[^/\s"'`<>|]+)/iu;
const inventory = [];
for (const file of files) {
  if (isPrivatePath(file)) throw new Error('除外対象が配布候補に含まれています。');
  const bytes = await readFile(join(paths.root, file));
  if (hasSecretCandidate(bytes.toString('utf8')) || personal.test(bytes.toString('utf8'))) throw new Error('秘密情報候補または固定ローカルパスを検出しました。内容は表示しません。');
  inventory.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const manifest = join(destination, 'source-manifest.json');
if (!checkOnly) await writeFile(manifest, JSON.stringify(inventory, null, 2) + '\n');
const zip = join(destination, 'dsh-siwc-bridge-0.3.0-source.zip');
// .NET ZIP writer is the OS library; JSON file paths travel through an env field.
if (!checkOnly) await promisify(execFile)(systemPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression; $rows=Get-Content -LiteralPath $env:DSH_SOURCE_MANIFEST -Encoding UTF8 | ConvertFrom-Json; $f=[IO.File]::Open($env:DSH_SOURCE_ZIP,[IO.FileMode]::Create); $z=New-Object IO.Compression.ZipArchive($f,[IO.Compression.ZipArchiveMode]::Create,$false); try { foreach($r in $rows) { $e=$z.CreateEntry($r.file,[IO.Compression.CompressionLevel]::Optimal); $e.LastWriteTime=[DateTimeOffset]::Parse("1980-01-01T00:00:00+00:00"); $s=$e.Open(); try { $b=[IO.File]::ReadAllBytes([IO.Path]::Combine($env:DSH_SOURCE_ROOT,$r.file)); $s.Write($b,0,$b.Length) } finally { $s.Dispose() } } } finally { $z.Dispose(); $f.Dispose() }'], { windowsHide: true, env: { ...process.env, DSH_SOURCE_MANIFEST: manifest, DSH_SOURCE_ZIP: zip, DSH_SOURCE_ROOT: paths.root } });
const packed = await runNode(resolveNpmCli(), ['pack', '--ignore-scripts', '--json', ...(checkOnly ? ['--dry-run'] : []), '--pack-destination', destination], { cwd: paths.root, capture: true });
if (packed.code !== 0) throw new Error('npm pack が失敗しました。');
const meta = JSON.parse(packed.stdout)[0];
for (const row of meta.files) {
  if (!/^(lib\/|scripts\/dpapi\.ps1$|docs\/|README\.md$|NOTICE$|LICENSE$|package\.json$|cordis\.patch\.yml$)/.test(row.path)) throw new Error('予期しないnpm配布内容です。');
  const content = (await readFile(join(paths.root, row.path))).toString('utf8');
  if (isPrivatePath(row.path) || hasSecretCandidate(content) || personal.test(content)) throw new Error('npm配布内容に秘密情報候補または固定ローカルパスがあります。');
}
if (!checkOnly) await writeFile(join(destination, 'package-manifest.json'), JSON.stringify(meta.files.map(row => ({ path: row.path, size: row.size })), null, 2) + '\n');
const archives = [zip, join(destination, meta.filename)];
if (!checkOnly) {
  const sums = await Promise.all(archives.map(async file => `${createHash('sha256').update(await readFile(file)).digest('hex')}  ${relative(destination, file)}`));
  await writeFile(join(destination, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
}
console.log(`${checkOnly ? 'CURRENT_CANDIDATES_ONLY' : 'LOCAL_ARCHIVE_ONLY'}: source ${inventory.length} files / npm ${meta.files.length} files。固定ローカルパス検査は現行source/npm候補のみ（Git履歴は対象外）。実ログイン・利用計上は別途確認。未公開。`);
