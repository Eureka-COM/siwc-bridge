import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntimePatch } from '../scripts/dsh-env.mjs';

test('the launcher profile routes web_search to the ChatGPT plan and leaves no DeepSeek-only page or provider to fail', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'siwc-dsh-patch-')), 'runtime.patch.yml');
  await writeRuntimePatch(file, { model: 'gpt-6.1-sol', webCredentials: true });
  const patch = await readFile(file, 'utf8');
  assert.match(patch, /- id: web\n {2}config:\n {4}searchProvider: "siwc"\n {4}fetchProvider: http\n/);
  for (const id of ['credentials', 'deepseek-account', 'llm-deepseek', 'llm-deepseek-account', 'account-controller', 'ui-settings-account', 'web-search-deepseek', 'ui-settings-web-search', 'session-telemetry-otel']) {
    assert.match(patch, new RegExp(`- id: ${id}\\n {2}disabled: true\\n`), id);
  }
  assert.match(patch, /- id: agent-default-model\n {2}config:\n {4}provider: "siwc"\n {4}model: "gpt-6.1-sol"\n/);
  // The mock-adapter fixture replaces the plugin, so it does not pin a provider the plugin would register.
  await writeRuntimePatch(file, { fixture: { evidencePath: join(tmpdir(), 'unused') } });
  assert.doesNotMatch(await readFile(file, 'utf8'), /searchProvider/);
});
