import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';

const slash = String.fromCharCode(92);
const drive = ['Z', ':'].join('');
const rejected = [
  drive + slash + ['Users', 'ExampleAccount', 'project'].join(slash),
  drive + '/' + ['Work', 'project'].join('/'),
  slash.repeat(2) + ['example-host', 'private-share', 'project'].join(slash),
  '/' + ['home', 'example-account', 'project'].join('/'),
  '/' + ['Users', 'ExampleAccount', 'project'].join('/'),
  'workspace=' + '/' + ['home', 'example-account', 'project'].join('/'),
  'workspace=' + slash.repeat(2) + ['example-host', 'private-share'].join(slash),
  slash.repeat(2) + '?' + slash + ['UNC', 'example-host', 'private-share'].join(slash),
  ['file', ':', '/', '/', '/'].join('') + ['home', 'example-account', 'project'].join('/'),
  ['file', ':', '/', '/'].join('') + ['example-host', 'private-share'].join('/'),
];
const allowed = [
  'https://github.com/Eureka-COM/siwc-bridge',
  'https://api.openai.com/v1/responses',
  'http://127.0.0.1:8080/auth/callback',
  '/auth/callback',
  'src/client.ts',
  '../integrations/dsh/',
  '%LOCALAPPDATA%' + slash + 'siwc-bridge',
  'process.env.LOCALAPPDATA',
  '// This is a normal source comment.',
  'const asset = "//cdn.example.org/assets/client.js";',
  'const pattern = ' + String.raw`/^\w+$/;`,
  'const matcher = ' + String.raw`/(\/.*\/[a-z]*);$/m;`,
];

for (const name of ['../scripts/release.mjs', '../integrations/dsh/scripts/release.mjs']) {
  test(`${name}: publication rejects fixed local paths and preserves portable references`, async () => {
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    const literal = source.match(/^const personal = (\/.*\/[a-z]*);$/m)?.[1];
    assert.ok(literal, 'Both publication entry points need a local-path guard');
    const matcher = runInNewContext(literal) as RegExp;
    for (const value of rejected) {
      assert.equal(matcher.test(value), true, 'Fixed local path must be rejected');
      assert.equal(matcher.test(JSON.stringify({ file: value })), true, 'JSON-escaped local path must be rejected');
    }
    for (const value of allowed) assert.equal(matcher.test(value), false, 'Portable reference must remain allowed');
  });
}

for (const name of ['../scripts/release.mjs', '../integrations/dsh/scripts/release.mjs']) {
  test(`${name}: source and npm publication reject token aliases and private keys`, async () => {
    const source = await readFile(new URL(name, import.meta.url), 'utf8');
    const old = source.match(/^const (?:secret|forbidden) = (\/.*\/[a-z]*);$/m)?.[1];
    const detects = old ? (text: string) => (runInNewContext(old) as RegExp).test(text)
      : (await import(new URL(name.replace('release.mjs', 'publication-safety.mjs'), import.meta.url).href)).hasSecretCandidate;
    const token = 'synthetic'.repeat(8);
    const candidates = [
      ['github', 'pat', token].join('_'),
      ...['ghp', 'gho', 'ghu', 'ghs', 'ghr'].map(prefix => prefix + '_' + token),
      ...['access_token', 'refresh_token', 'id_token', 'accessToken', 'refreshToken', 'idToken', 'api_key', 'apiKey', 'client_secret', 'clientSecret'].map(field => JSON.stringify({ [field]: token })),
      ['-----BEGIN ', 'ENCRYPTED ', 'PRIVATE KEY-----'].join(''),
      ['-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----'].join(''),
    ];
    const unicodeJson = '{"refresh' + String.raw`\u0054` + 'oken":"' + token + '"}';
    candidates.push(JSON.stringify({ authorization: 'Bearer ' + token }), JSON.stringify(JSON.stringify({ refreshToken: token })), unicodeJson, JSON.stringify(unicodeJson));
    for (const candidate of candidates) assert.equal(detects(candidate), true, 'Synthetic credential candidate must be blocked');
    for (const text of ['const token = process.env.TOKEN;', JSON.stringify({ refreshToken: '<REDACTED>' }), 'fake-access-never-real', 'https://auth.openai.com']) {
      assert.equal(detects(text), false, 'Portable references and explicit placeholders remain allowed');
    }
  });
}

test('Git ignore blocks credential temporaries, private keys and private workspaces', () => {
  for (const prefix of ['', 'integrations/dsh/']) {
    for (const file of ['credentials.dpapi.synthetic.tmp', 'credentials.json', 'credential.backup.json', 'auth.json', 'auth-cache.json', 'auth2.json', 'tokens.json', 'private-key.pem', 'private.key', '.codex/state.json', '.dsh/state.json', '.private/session.json']) {
      const result = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { input: prefix + file + '\n', encoding: 'utf8' }).trim();
      assert.equal(result, prefix + file);
    }
  }
});

test('SDK and standalone DSH use byte-identical publication rules', async () => {
  const sdk = await readFile(new URL('../scripts/publication-safety.mjs', import.meta.url), 'utf8');
  const dsh = await readFile(new URL('../integrations/dsh/scripts/publication-safety.mjs', import.meta.url), 'utf8');
  assert.equal(dsh, sdk);
  const { isPrivatePath } = await import('../scripts/publication-safety.mjs');
  for (const file of ['docs/auth.json', 'src/credentials.dpapi.synthetic.tmp', 'scripts/private.key', 'src/.private/session.json']) assert.equal(isPrivatePath(file), true);
  for (const file of ['package-lock.json', 'src/auth.ts', 'docs/COMPLIANCE.md', 'scripts/dpapi.ps1', 'lib/client.js']) assert.equal(isPrivatePath(file), false);
});
