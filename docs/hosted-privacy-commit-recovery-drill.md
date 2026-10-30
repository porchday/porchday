# Hosted privacy commit recovery drill

Planned acceptance for #1 and #42. This document does not authorize clearing a
pending operation or enabling the public privacy commit writer. The compatible
staging reader floor and actual API rollback are verified; hosted marker-only
recovery remains outstanding.

On October 30, the first temporary-object conditional-write probe failed with
`R2_OPERATOR_REQUEST_FAILED`. No journal-control or member-data key was allowed
by its transport. The owned deployment lease was reconciled without dispatching
an upload or activation. The probe did not retain its generated key before I/O,
so its temporary-object cleanup is unknown. Do not claim conditional-write
acceptance or delete unrelated probe objects. The next independent probe must
persist the exact key and each request phase before I/O and retain bounded,
non-sensitive transport diagnostics. Cleanup must have its own bounded deadline
even if the verification deadline expires.

## Method

Use the existing R2 operator adapter and a supervised local child process against
the existing staging database and journal. A new public fault endpoint or Worker
is unnecessary. Before any journal write, verify conditional create, matching
ETag replacement and stale ETag refusal on one random `probes/` object, then
remove it. The transport must reject every other object key for that probe.

The parent holds the release lease and persists a one-shot execution record. It
verifies current provider state, reader floor, schema 057, runtime source, journal
generation, no pending operations, and healthy independent production probes.
Create only explicitly owned synthetic accounts. Record their exact identities
privately before creation; never use a real member or a new shared fixture table.
Retain a second account for independent continuity checks.

The child uses the actual intent/scope publication functions and real conditional
R2 writes. Its single SQL transaction must lock and revalidate the owned account,
perform an exact synthetic auth mutation, and invoke
`app.complete_privacy_transaction` before COMMIT on that same connection. Use the
auth role and existing SQL authorization rules, with bounded statement, lock and
transaction timeouts. A marker in a separate transaction is not acceptable.

After an acknowledged COMMIT, the child sends only the operation ID and phase to
the parent and parks before checkpoint/receipt completion. The parent independently
checks the owned mutation and matching SQL marker/fence, then kills that child
with SIGKILL. Do not kill at registration or before COMMIT against the shared
staging journal: those unknown outcomes intentionally fail closed and remain
covered by the isolated local crash matrix.

Verify the receipt is absent and the exact pending entry remains. Retain the
original intent and scope digests and the canonical baseline. Do not backdate the
intent or shorten the real 120-second stale threshold. Observe normal hosted
read/cron recovery through the deployed reader, without using local recovery as
the acceptance path. The ordinary hosted code must export the committed marker,
prove canonical ancestry, publish the normal v1 receipt and retire the pending
entry without replaying SQL or the user action.

## Acceptance and failure handling

- Record all timed observations; use the existing 10-second journey and 5-second
  continuity limits. Do not replace failed samples with retries. Measure the
  stale interval separately from recovery request latency.
- Prove the exact marker is on the canonical chain after the scope baseline,
  the receipt names a valid checkpoint, the fence and owned mutation occurred
  once, the generation is unchanged, and no unrelated pending entry disappeared.
- Verify both accounts' expected session behavior and protected readiness before,
  during and after recovery. A successful control update alone is insufficient.
- Reconcile the original operation on any timeout or lost reply. Never restart
  registration, replay the auth mutation, synthesize a marker, delete an intent,
  overwrite control state, or release existing quarantine to make the test pass.
- If normal hosted recovery does not complete within the reviewed bound, retain
  failure and stop promotion. Any operator fallback must independently prove the
  same canonical marker and use the maintained recovery path. It cannot count as
  successful automatic recovery. Unknown outcomes remain unresolved.
- Log out the surviving synthetic sessions normally, verify session rejection,
  remove exactly the owned SQL fixture rows, retain immutable journal evidence,
  and verify provider inventory and a free lease afterward. Preserve credentials
  privately until cleanup is verified, then remove temporary cookie material.

The implementation must test its parent/child phase protocol, one-shot records,
ownership checks, timeout behavior and failure reconciliation before hosted
execution. The hosted plan must pin the reviewed scripts and source. No existing
writer draft or stale deployment manifest may be reused.

## What this can establish

This method exercises process loss with real hosted SQL/R2 state and recovery by
the actual deployed Worker. It does not terminate a Cloudflare isolate or execute
the entire HTTP auth writer in that isolate. Those limits must remain explicit.
An eventual writer rollout still needs normal hosted auth-path acceptance,
concurrency, recovery latency/cost, compatible rollback and production admission.
No local or staging drill establishes monthly 99.99% availability by itself.
