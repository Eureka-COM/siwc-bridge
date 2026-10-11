# Independent audit regression tests

`audit-replay-boundary.mjs` and `audit-response-guards.mjs` come from an
independent review of v0.2.1 (2026-10-11) and are distributed by their author
under CC0-1.0. They run offline: `fetch` is replaced before import, and only
synthetic tokens and history are used.

`tests/audit.test.ts` runs them against the built `lib/` on every `npm test`.
The replay test runs with `--expect-fixed`: a request whose token belongs to a
different registration than the reused history must never reach `fetch`.
