import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

test('independent audit: a token from another registration never reaches fetch with reused history', async () => {
  const { stdout } = await run(process.execPath, [path('./audit/audit-replay-boundary.mjs'), path('../lib/client.js'), '--expect-fixed'], { windowsHide: true });
  const report = JSON.parse(stdout);
  assert.equal(report.securityStatus, 'NO_CROSS_IDENTITY_DISPATCH_IN_THESE_FIXTURES');
  assert.equal(report.realNetworkRequests, 0);
  for (const row of report.summary) assert.equal(row.crossIdentityDispatches, 0);
});

test('independent audit: response size limits and tool-response guards', async () => {
  const { stdout } = await run(process.execPath, [path('./audit/audit-response-guards.mjs'), path('../lib')], { windowsHide: true });
  const report = JSON.parse(stdout);
  const rows = report.results ?? report.tests ?? [];
  assert.ok(rows.length >= 14);
  for (const row of rows) assert.equal(row.result, 'PASS');
});
