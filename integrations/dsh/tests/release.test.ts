import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { hasSecretCandidate, isPrivatePath } from '../scripts/publication-safety.mjs';

test('standalone DSH publication rejects fixed paths and accepts portable references', async () => {
  const source = await readFile(new URL('../scripts/release.mjs', import.meta.url), 'utf8');
  const literal = source.match(/^const personal = (\/.*\/[a-z]*);$/m)?.[1];
  assert.ok(literal, 'Standalone publication needs a local-path guard');
  const matcher = runInNewContext(literal) as RegExp;
  const slash = String.fromCharCode(92);
  const local = ['Y', ':', slash, 'Users', slash, 'ExampleAccount'].join('');
  assert.equal(matcher.test(local), true);
  assert.equal(matcher.test(JSON.stringify({ file: local })), true);
  assert.equal(matcher.test(slash.repeat(2) + ['example-host', 'private-share'].join(slash)), true);
  assert.equal(matcher.test('/' + ['home', 'example-account', 'project'].join('/')), true);
  assert.equal(matcher.test('workspace=' + '/' + ['home', 'example-account', 'project'].join('/')), true);
  assert.equal(matcher.test('workspace=' + slash.repeat(2) + ['example-host', 'private-share'].join(slash)), true);
  assert.equal(matcher.test(slash.repeat(2) + '?' + slash + ['UNC', 'example-host', 'private-share'].join(slash)), true);
  assert.equal(matcher.test(['file', ':', '/', '/', '/'].join('') + ['home', 'example-account'].join('/')), true);
  for (const value of ['https://api.openai.com/v1/responses', '//cdn.example.org/assets/client.js', 'src/adapter.ts', '%LOCALAPPDATA%' + slash + 'siwc-bridge-dsh', '/auth/callback']) {
    assert.equal(matcher.test(value), false);
  }
});

test('standalone DSH has the shared credential and private-file guard without an SDK checkout', () => {
  const token = 'synthetic'.repeat(8);
  for (const text of [['github', 'pat', token].join('_'), 'ghp' + '_' + token, JSON.stringify({ refreshToken: token }), JSON.stringify(JSON.stringify({ access_token: token }))]) assert.equal(hasSecretCandidate(text), true);
  assert.equal(hasSecretCandidate(JSON.stringify({ refreshToken: '<REDACTED>' })), false);
  assert.equal(isPrivatePath('src/credentials.dpapi.synthetic.tmp'), true);
  assert.equal(isPrivatePath('lib/adapter.js'), false);
});
