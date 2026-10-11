import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiwcAdapter } from '../lib/adapter.js';
import { testLedger } from '../lib/ledger.js';

const options = { provider: 'siwc', model: 'fixture', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'fixture' }] }] };
const run = async (adapter: SiwcAdapter) => { for await (const _ of adapter.stream(options)) { /* drain */ } };
const ok = () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
  { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }] } })}\n\n`,
{ headers: { 'content-type': 'text/event-stream' } });
const credentials = { withAccessToken: (operation: any) => operation('synthetic-test-only') };

test('a running adapter picks up a resume made in another process and never re-records its own stale stop', async () => {
  const original = globalThis.fetch;
  const shared = { stopped: false, generation: 4 }; let stops = 0; let sent = 0; let limit = true;
  try {
    globalThis.fetch = async () => { sent++; return limit ? Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429 }) : ok(); };
    const adapter = new SiwcAdapter(credentials, { onUsageLimit: async () => { stops++; shared.stopped = true; }, usageState: async () => ({ ...shared }) });
    await assert.rejects(run(adapter), { code: 'QUOTA' });
    assert.equal(stops, 1); assert.equal(sent, 1); assert.equal(await adapter.usageLimited(), true);
    await assert.rejects(run(adapter), { code: 'QUOTA' });
    assert.equal(sent, 1); assert.equal(stops, 1, 'a local stop must not write the shared stop again');
    // Another process (CLI resume) records a new human start.
    shared.stopped = false; shared.generation = 5; limit = false;
    assert.equal(await adapter.usageLimited(), false);
    await run(adapter); assert.equal(sent, 2);
  } finally { globalThis.fetch = original; }
});

test('the shared ledger records a new generation on every human start and the running adapter follows it', async () => {
  const original = globalThis.fetch;
  const directory = await mkdtemp(join(tmpdir(), 'siwc-dsh-resume-'));
  const ledger = testLedger(join(directory, 'verification.json'));
  let sent = 0; let limit = true;
  try {
    globalThis.fetch = async () => { sent++; return limit ? Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429 }) : ok(); };
    assert.equal((await ledger.start()), 'started');
    const before = (await ledger.usageState()).generation;
    const running = new SiwcAdapter(credentials, { beforeRequest: (kind, signal) => ledger.request(kind, signal), onUsageLimit: () => ledger.stop(), usageState: () => ledger.usageState() });
    await assert.rejects(run(running), { code: 'QUOTA' });
    assert.deepEqual(await ledger.usageState(), { stopped: true, generation: before });
    // The CLI resume runs in its own process with its own adapter; here only the shared file changes.
    await ledger.resume({ settingsConfirmed: true });
    assert.deepEqual(await ledger.usageState(), { stopped: false, generation: before + 1 });
    limit = false;
    await run(running);
    assert.equal(sent, 2);
    assert.equal((await ledger.status()).personalUse, true);
  } finally { globalThis.fetch = original; }
});
