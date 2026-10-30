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

The instrumented second probe returned HTTP 200 for both the initial conditional
create and the attempted duplicate conditional create. Its gate rejected the REST
adapter with `R2_CONDITIONAL_WRITES_UNSUPPORTED`. The exact probe object's DELETE
returned 200 and the owned lease was released. This endpoint must not be used for
journal compare-and-swap writes. The existing `withOperatorR2` bridge uses native
R2 bindings and must independently pass its live conditional-write gate before
the recovery drill can proceed.

The native bridge gate subsequently passed at 02:03:39 UTC on October 30. It
verified conditional creation, matching-ETag replacement, stale-ETag refusal,
final object contents and probe deletion; an unauthenticated write was rejected.
The bridge's normal teardown verified removal of its exact temporary Worker and
domain. Canonical deployment state was unchanged and the release lease was
released. No journal control or member-data mutation occurred. This establishes
the transport prerequisite only; hosted marker-only recovery is still untested.

## Method

Use the existing temporary native-R2 operator bridge and a supervised local child
process against the existing staging database and journal. No fault switch belongs
in the public application. Before any journal write, verify conditional create, matching
ETag replacement and stale ETag refusal on one random `probes/` object, then
remove it. The transport must reject every other object key for that probe.
Persist the temporary bridge script identity before upload and verify removal of
its exact script and domain during teardown. Its secret capability must remain
in memory and out of logs and command arguments. The REST read adapter is not a
substitute for native conditional-write verification.
Keep the bridge capability in the parent process. A bounded IPC journal adapter
can let the child call the actual journal functions while the parent retains
operation-scoped request records and enforces the permitted keys. It must not
print or serialize the capability into a fixture file.

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

## Implemented bridge components

`scripts/commit-drill-store.ts` restricts the parent's native journal capability
to one newly created intent, an exact conditional append of that intent to the
observed pending list, and its digest-bound immutable scope. It preserves other
pending entries and refuses receipt/batch writes, retirement, generation changes,
quarantine changes and adoption of an existing intent. Each request is recorded
before I/O; only hashes, keys and fixed outcomes belong in the private evidence
sink. It permits one in-flight call, at most 32 requests, 64 KiB documents and a
60-second preparation lifetime. Each call has a maximum five-second deadline.
An uncertain result seals the capability; the supervisor must reconcile it.

`scripts/commit-drill-ipc.ts` carries bounded, strictly validated messages with
monotonic request IDs. The parent retains its R2 capability; the child gets only
journal results. Invalid messages, lost replies and deadlines close the channel
without retry. Tests exercise real serialized MessagePort transport as well as
the actual intent/scope functions through the store gate.

The SQL child now checks a staging database target (or an explicitly disposable
local test database) and an exact run-tagged synthetic account/session before
registration. It deletes only that session under the auth role and identity lock,
then writes the marker as the final SQL action in the same transaction. SQL uses
five-second statement, one-second lock and fifteen-second transaction limits.
After acknowledged COMMIT it closes its database connection, reports the phase
and parks without any receipt/checkpoint call. Credentials arrive through private
IPC, never command arguments; the R2 capability remains in the parent.

The supervisor seals the child's journal access and requires independent marker,
fence, generation, ownership, session-absence, exact pending and receipt-absence
checks before persisting kill intent. It requires an actual SIGKILL exit and never
labels that exit recovery success. Missing evidence or a failed evidence sink
prevents signaling. The verifier callback and durable sink must be supplied by
the reviewed hosted runner; a child report alone is insufficient.

Local validation passes 84 focused tests, including real PostgreSQL 17, the real IPC child,
parent-authorized SIGKILL and recovery through the ordinary recovery function.
The integration test advances its local clock beyond the stale threshold; hosted
execution must wait the unchanged real threshold. Wrong ownership, generation
mismatch and duplicate-marker attempts roll back session deletion and marker
allocation together. This is local database/filesystem-journal acceptance.

The parent runner now serializes and validates registered/scoped/committed phases,
binds their operation identity to the gated store, and binds the scope digest to
the parent's retained publication record. Its independent observer reads the
original intent/scope, SQL marker/fence, exact synthetic ownership/session state,
generation/cursor and pending/receipt state. Altered digests, malformed phases,
reordering and mismatched sequence reports cannot authorize a kill. Evidence
retention is deadline-bound, including a bounded reconciliation attempt after
failure. On uncertain outcomes, it seals journal access and disconnects rather
than killing a potentially uncommitted transaction or replaying it. A child that
never received initialization may be terminated safely.

The read-only post-recovery observer now verifies the exact marker against the
canonical ancestry, a receipt checkpoint at or after that marker, the unique SQL
fence, owned session absence and pending retirement. It uses the retained original
intent in an in-memory proof view; it never writes that view to journal control.
It checks generation and quarantine before and after SQL inspection, refuses
unexplained removal of unrelated pending entries, and rechecks canonical ancestry
after concurrent checkpoint advancement. A ten-second overall deadline bounds
stalled reads. It requires the original intent to be at least 120 seconds old and
never advances the clock or invokes recovery itself. Real PostgreSQL integration
covers successful observation after ordinary recovery, refusal before recovery,
missing/too-old receipts and missing unrelated pending entries. Unit tests cover
stalled reads and cancellation. The result explicitly leaves hosted recovery-path
verification false: the hosted invocation must independently establish that path.

Two October 30 hosted invocation attempts stopped before any child journal request
or intent registration. The first refused the configured connection's explicit
`sslmode=verify-full` query option. The separately reviewed second invocation
normalized only that verified option, retaining explicit full TLS verification,
but failed its read-only auth-role assumption with SQLSTATE `42501`. Read-only
reconciliation verified both original sessions remained and no pending drill
intent existed. Each attempt's two continuity samples passed. Both attempts then
logged out and removed exactly their two owned fixture accounts, verified removal
of their temporary bridge Worker/domain, rechecked unchanged provider state and
released the lease. Both remain failed acceptance; neither exercised recovery.

Read-only permission inspection confirmed the deployed role split: auth can write
the commit marker but cannot read journal status/pages; jobs can read the journal
but cannot write a commit marker. The drill now requires separate auth and journal
connections for staging, validates both against the staging branch, and carries
both only over private IPC. The local full-parent integration now uses actual
restricted auth/jobs logins, explicitly verifies those permission boundaries, and
passes through COMMIT, parent proof, SIGKILL and ordinary local recovery. No grants
or deployed database permissions were broadened. Hosted invocation must supply the
existing auth and jobs credentials and normalize only verified connection options.

The third hosted invocation reached registration but failed scope publication
because the temporary operator Worker omitted the commit-scope key namespace.
The original intent was preserved and staging entered quarantine. Guarded
original-primary recovery restored staging without changing SQL or capabilities;
all four queues resumed and exact fixture cleanup passed. This remains failed
automatic-recovery acceptance. See the [transport incident evidence](evidence/privacy-commit-drill-transport-staging-2026-10-30.md).

The bridge now supports immutable v1 scope keys. Set `requireCommitScopes: true`
on a hosted drill's `withOperatorR2` invocation so its read-only namespace probe
runs before the callback can register an intent. The full local parent test now
also uses the actual operator Worker with native R2 bindings and restricted SQL
roles; this covers the transport omission that the filesystem-only test missed.

The full parent runner passes the local integration test with the actual IPC
child and ordinary recovery function. Hosted deployment/source admission,
fixture lifecycle, native bridge setup/teardown, real-time continuity and
deployed-reader recovery observations still need to be assembled into the
reviewed one-shot hosted invocation. Passing the parent test does not establish
hosted recovery, successful hosted cleanup or production acceptance.

## What this can establish

This method exercises process loss with real hosted SQL/R2 state and recovery by
the actual deployed Worker. It does not terminate a Cloudflare isolate or execute
the entire HTTP auth writer in that isolate. Those limits must remain explicit.
An eventual writer rollout still needs normal hosted auth-path acceptance,
concurrency, recovery latency/cost, compatible rollback and production admission.
No local or staging drill establishes monthly 99.99% availability by itself.
