# Staging browser-triggered recovery — October 30, 2026 UTC

The maintained controller activated a retained staging frontend build, observed a
controlled fresh-browser exception, and restored the exact prior baseline. The
exception existed only in the observer’s fresh Chromium context. No faulty files
or responses were served to other clients. Production was unchanged.

Tooling `c1801769f1a2240cf2de233c204a11cfcafb43e4` passed 97 targeted tests,
both TypeScript configurations, formatting/secret checks, and all six exact-commit
CI checks before execution. The separate continuity harness passed 16 synthetic
read checks; live preflight matched provider inventory and all 33 baseline asset
checks. Historical drill operations were not replayed.

## Observed result

- Activation operation: `2783bddd-04c4-4442-ab33-dd2f3200bba8`.
- Candidate: `f964f1f2-6c55-4c38-b2f9-e05688d23f2e`, with retained b2b3a069 assets.
- Restored baseline: `89eec37f-e097-4e65-9b71-42ad08d854de`, with d6fd3fa assets.
- The journal progressed through candidate observation and rollback intent to
  `rolled-back`; it never declared the candidate complete.
- The browser report recorded exactly one injected fresh-client exception. Old
  form state, one cold lazy module, exact asset bytes/MIME, fresh document and
  rendering all passed; there were no other page or module-MIME errors.
- Eighteen authenticated continuity samples passed, including candidate and
  rollback phases. Two samples **started after** the command-terminal timestamp;
  maximum sample-start gap was 2,002.55 ms. These are sampled API observations,
  not a claim of uninterrupted success for every possible request.
- Browser failure report to command-terminal result: 18,540 ms. Command intent
  to terminal result: 30,527 ms. These intervals include verification/finalization
  and must not be reported as a measured user-visible outage or a general SLA.
- Final acceptance at 00:02:13 UTC verified restored provider inventory, zero
  owned synthetic fixture rows, retained denial records and a released deployment
  lease. The staging backend, schema and isolated queues were preserved.

## Alert delivery

The installed independent Mac watcher delivered the
[exact notification-drill bot comment](https://github.com/porchday/porchday/issues/3#issuecomment-6511459296).
Its body matched the immutable outbox, exactly one matching bot comment existed,
and the local delivery receipt matched the event digest. Two subsequent polls
reported zero pending notifications and errors. Read-only final verification
passed at 00:03:25 UTC. Owner inbox receipt remains unverified.

## Limits and next acceptance

This proves hosted staging-edge recovery following an observer browser fault. It
does not prove provider-wide failover, combined-worker hosted recovery, signed-in
UI or installed/native client compatibility. The actual scheduled daily-feature
release gate is configured but remains unverified by an eligible scheduled run.
The ordinary hourly automation remains on the normal browser entry point at
9a4efad6; it never invokes this drill. No production runtime changed, and the
monthly 99.99% availability objective is not established by this test.

Machine-readable measurements: [JSON](browser-fault-recovery-staging-2026-10-30.json).
