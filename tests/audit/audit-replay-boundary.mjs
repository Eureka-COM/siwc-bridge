/**
 * SIWC SDK replay/credential identity boundary audit (offline).
 *
 * Usage (run after building the trusted SDK):
 *   node audit-replay-boundary.mjs <path-to-lib/client.js> [--expect-fixed]
 *
 * Imports ONLY the SDK client, not its Windows AuthManager. All credentials,
 * request scopes and HTTP responses are synthetic. globalThis.fetch is replaced
 * before import; the real fetch is never called. No real login, key, wallet,
 * Windows credential store or paid API is used. No files are written.
 *
 * Models the interval between AuthCore.select() publishing activeId=B and its
 * second cancelRequests() publishing the next epoch. Windows OS scheduling and
 * DPAPI are NOT tested by this fixture.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = process.argv.slice(2);
if (!cli[0] || cli[0].startsWith('--') || cli.slice(1).some(x => x !== '--expect-fixed')) {
  console.error('Usage: node audit-replay-boundary.mjs <path-to-lib/client.js> [--expect-fixed]');
  process.exit(2);
}
const expectFixed = cli.includes('--expect-fixed');
const moduleUrl = pathToFileURL(resolve(cli[0])).href;
const originalFetch = globalThis.fetch;
let handler = async () => { throw new Error('Unexpected HTTP attempt before fixture setup'); };
globalThis.fetch = (...args) => handler(...args);

function completedResponse(index) {
  const event = {
    type: 'response.completed',
    response: {
      id: `fixture_response_${index}`, status: 'completed',
      output: [
        { id: `fixture_reasoning_${index}`, type: 'reasoning', summary: [],
          encrypted_content: 'SYNTHETIC_A_HISTORY_NOT_A_REAL_ENCRYPTED_TOKEN' },
        { id: `fixture_message_${index}`, type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'SYNTHETIC_A_MESSAGE_NOT_PERSONAL_DATA' }] },
      ],
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}

try {
  const { SiwcClient } = await import(moduleUrl);
  assert.equal(typeof SiwcClient, 'function', 'Expected the trusted SDK SiwcClient export');
  const results = [];
  const scenarios = ['same_registration', 'switched_before_start', 'cancel_before_send',
    'switch_between_status_and_token', 'switch_then_cancel_after_dispatch'];

  for (const scenario of scenarios) {
    for (let iteration = 1; iteration <= 10; iteration++) {
      let activeId = 'fixture_registration_A';
      let phase = 'seed';
      let credentialCalls = 0;
      let epoch = 1;
      const scopes = new Set();
      const calls = [];
      const publishCancellation = () => {
        epoch++;
        for (const controller of scopes) controller.abort();
      };
      const credentials = {
        async status(signal) {
          signal?.throwIfAborted();
          return { activeId };
        },
        async openRequestScope(signal) {
          const expectedEpoch = epoch;
          const controller = new AbortController();
          scopes.add(controller);
          const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
          return {
            signal: combined,
            async check() {
              if (expectedEpoch !== epoch) controller.abort();
              combined.throwIfAborted();
            },
            close() { scopes.delete(controller); },
          };
        },
        async withAccessToken(operation, signal) {
          signal?.throwIfAborted();
          credentialCalls++;
          if (phase === 'probe' && ['cancel_before_send', 'switch_between_status_and_token',
            'switch_then_cancel_after_dispatch'].includes(scenario)) {
            // Emulate another process publishing the new credential snapshot.
            activeId = 'fixture_registration_B';
            if (scenario === 'cancel_before_send') publishCancellation();
          }
          signal?.throwIfAborted();
          const token = activeId.endsWith('_A') ? 'SYNTHETIC_ACCESS_A' : 'SYNTHETIC_ACCESS_B';
          // Third argument is the token-bound identity, as already used by the
          // DSH adapter. Current SDK ignores it; a DSH-style fix can consume it.
          const result = await operation(token, signal, activeId);
          signal?.throwIfAborted();
          return result;
        },
      };
      handler = async (url, init) => {
        // Observe request construction without opening ANY socket.
        assert.equal(String(url), 'https://api.openai.com/v1/responses');
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error');
        const authorization = new Headers(init.headers).get('authorization');
        assert.ok(['Bearer SYNTHETIC_ACCESS_A', 'Bearer SYNTHETIC_ACCESS_B'].includes(authorization));
        const body = JSON.parse(init.body);
        calls.push({ phase, account: authorization.endsWith('_B') ? 'B' : 'A',
          priorNativeHistory: body.input.some(item => item.id === 'fixture_reasoning_1'),
          priorAssistantMessage: body.input.some(item => item.id === 'fixture_message_1') });
        if (phase === 'probe' && scenario === 'switch_then_cancel_after_dispatch') publishCancellation();
        return completedResponse(calls.length);
      };
      const client = new SiwcClient(credentials, {
        async beforeRequest(_kind, signal) { signal.throwIfAborted(); },
      });
      // Obtain prior history through the actual SDK completion path. No private
      // map mutation, provenance bypass, response parser stub, or fake digest.
      const first = await client.complete({ model: 'fixture_model',
        input: [{ role: 'user', content: 'Synthetic first turn' }] });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].account, 'A');
      phase = 'probe';
      if (scenario === 'switched_before_start') activeId = 'fixture_registration_B';
      let errorCode = null;
      try {
        await client.complete({ model: 'fixture_model', input: [
          { role: 'user', content: 'Synthetic first turn' }, ...first.output,
          { role: 'user', content: 'Synthetic continuation' },
        ] });
      } catch (error) { errorCode = typeof error?.code === 'string' ? error.code : error?.name; }
      const outbound = calls.filter(call => call.phase === 'probe');
      const crossedBoundary = outbound.some(call => call.account === 'B'
        && call.priorNativeHistory && call.priorAssistantMessage);
      if (scenario === 'same_registration') {
        assert.equal(errorCode, null); assert.equal(outbound.length, 1); assert.equal(crossedBoundary, false);
      } else if (scenario === 'switched_before_start') {
        assert.equal(errorCode, 'INVALID_REPLAY_CONTEXT'); assert.equal(outbound.length, 0);
      } else if (scenario === 'cancel_before_send') {
        assert.ok(errorCode); assert.equal(outbound.length, 0);
      } else if (expectFixed) {
        assert.equal(outbound.length, 0, `${scenario}: a changed token identity must be rejected BEFORE fetch`);
      } else {
        assert.equal(crossedBoundary, true, `${scenario}: expected current vulnerability did not reproduce`);
        assert.ok(errorCode, 'Current SDK eventually rejects completion, but only after dispatch');
      }
      assert.equal(scopes.size, 0, 'SDK must close all fixture scopes');
      results.push({ scenario, iteration, probeDispatches: outbound.length,
        crossedBoundary, eventualError: errorCode, credentialCalls });
    }
  }
  const summary = scenarios.map(scenario => {
    const rows = results.filter(row => row.scenario === scenario);
    return { scenario, iterations: rows.length,
      dispatches: rows.reduce((n, row) => n + row.probeDispatches, 0),
      crossIdentityDispatches: rows.filter(row => row.crossedBoundary).length,
      eventualErrors: [...new Set(rows.map(row => row.eventualError))] };
  });
  console.log(JSON.stringify({
    testedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    mode: expectFixed ? 'assert_fix' : 'reproduce_current_send_boundary_defect',
    securityStatus: summary.some(row => row.crossIdentityDispatches > 0)
      ? 'CROSS_IDENTITY_DISPATCH_REPRODUCED_WITH_SYNTHETIC_AUTH_AND_HTTP'
      : 'NO_CROSS_IDENTITY_DISPATCH_IN_THESE_FIXTURES',
    realNetworkRequests: 0, realCredentialsUsed: false, windowsDpapiTested: false,
    controlsAndReproductionAssertions: results.length, summary,
  }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
