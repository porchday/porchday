# Independent proof of committed privacy transactions

Work in progress for #1 and #42. The atomic SQL writer, independent verifier
and guarded active reconciliation are implemented and tested locally. Migration
057 and the recovery reader are now deployed in staging; marker writing remains
disabled. Production is unchanged. See the
[staging rollout evidence](evidence/auth-commit-reader-staging-2026-10-30.md).
Existing quarantine and receipt rules remain authoritative; this is not an
operator command to clear a pending operation.

## Failure being addressed

Today, an auth transaction can commit and the Worker can stop before writing
its completion receipt. A later checkpoint can contain the committed privacy
decisions, but those decisions do not identify the registered operation. The
existing recovery code cannot infer that the whole operation finished. A
matching database cursor, elapsed time or a SQL completion row alone is
insufficient evidence after a restore.

The protocol binds an independently registered single-transaction
operation to a terminal marker committed atomically with its SQL work. Recovery
requires that marker to reach the canonical independent journal chain. Missing
markers stay unresolved; neither user actions nor SQL mutations are replayed.
Generic routes containing multiple transactions or external side effects are
not eligible merely because they use the existing journal middleware.

## Protocol and compatibility

1. Retain the existing immutable v1 intent and pending registration. Before
   starting SQL, write one immutable `commit-scopes/v1/<operation>.json` record.
   It binds the exact intent bytes, operation ID/start time, generation,
   `single-auth-transaction` contract and current canonical checkpoint baseline.
   The scope digest binds all these fields. An absent scope preserves legacy
   behavior. Conflicting immutable scope bytes must refuse execution.
2. In the same PostgreSQL transaction as all protected auth changes, record one
   terminal `privacy_operation_committed` event containing only the operation
   ID and scope digest. A transactional unique fence must prevent a second
   committed transaction from using the same operation identity. The marker
   must be appended after the handler's SQL work and before COMMIT. Rollback
   removes both the changes and marker. No marker may be written in a separate
   follow-up transaction as a substitute for atomicity.
3. The existing checkpoint exporter publishes committed events as hash-linked
   immutable batches. A SQL row or an orphan batch is not independent proof;
   the marker must be on the canonical chain after the scope's exact baseline.
4. Recovery validates scope, original intent, generation, digest, marker and
   canonical ancestry. It rechecks current SQL generation/cursor/quarantine
   after proof, then publishes the ordinary immutable receipt before retiring
   the pending entry through CAS. Every CAS race requires a fresh read/proof.
   Unknown operations remain pending; existing quarantine is not automatically
   released. A missing marker must never be synthesized from SQL cursor parity.

The marker is recovery metadata, not an authorization decision or a replayable
user command. Restore must recognize it as a validated no-op while retaining
its journal sequence. That requires explicit SQL and operator restore handling
before any writer can emit it. App rollback, old receipt readers, completed
backup restore and current rollback floors must be reviewed together. Existing
v1 intents and receipts remain unchanged; the side record is an explicit opt-in.
Do not enable the writer until compatibility is demonstrated.

## Implemented verifier

`apps/api/src/privacy-commit-proof.ts` exposes `provePrivacyCommits`, a read-only
function with no database access or storage mutation method. It returns only
proven operation IDs with marker sequences and scope digests. It does not
retire intents, create receipts, export a checkpoint or release quarantine.

It validates exact original intent bytes and matching registered identity/time,
generation, transaction contract, baseline and canonical batch ancestry. It
rejects wrong-scope or duplicate markers, malformed chains and unreadable
storage. Missing scopes and missing anchored markers remain unproven. It stops
at each exact registered baseline, not an arbitrary old sequence or orphan
pointer. Read/traversal/document-size limits and cancellation checks bound the
verifier's own work; cancellation cannot interrupt an in-flight `JournalStore`
read because that interface has no cancellation argument. Runtime I/O deadlines
still need to be enforced by the caller/adapter.

## Writer and active recovery

Migration 057 adds an RLS-protected unique operation fence and grants only
`porchday_auth` execution of `complete_privacy_transaction`. The function checks
generation and quarantine, appends the terminal marker and inserts the fence
inside the caller's transaction. A duplicate throws and rolls back the second
attempt, including any work performed before its terminal call. The auth route
calls it immediately before COMMIT on the same connection. Existing generic
privacy middleware never opts into the single-transaction contract.

`PRIVACY_COMMIT_RECOVERY_V1=true` enables stale-intent recovery in the read guard
and checkpoint path. After the existing 120-second stale threshold, it exports
committed history, proves canonical markers, revalidates SQL and control, writes
ordinary v1 receipts and retires proven entries through conditional updates.
Unknown entries remain pending and lead to quarantine. It never replays work or
releases existing quarantine. The receipt and marker proof share a 1,024-read
budget; reconciliation makes at most eight attempts. Existing checkpoint and
I/O bounds still apply. This is not a new guarantee of a total request deadline.

`PRIVACY_COMMIT_WRITER_V1=true` opts eligible auth requests into scope and marker
creation. Writer startup refuses before registering an intent or starting work
unless recovery is also enabled. Both flags default off. Staging explicitly enables the recovery reader;
its writer flag and both production flags remain absent. Rollback-only failures retain existing receipt handling;
missing scope or missing marker does not become evidence of rollback.

## Local verification

Tests use a disposable PostgreSQL 17 database and the actual auth transaction,
not just a mocked SQL cursor. They cover atomic commit/rollback, duplicate and
concurrent attempts, least-privilege grants, malformed scopes, generation and
quarantine checks, and validated restore of a missing marker/fence. The existing
restore action dispatch is retained byte for byte. The full local replay/release
path also processes the marker after restoring older fixture rows and deleting
the SQL fence; credential holds remain, restored sessions/reset tokens are
removed, and the fence is rebuilt. A separate real pre-057 dump/restore drill now verifies the full local path;
see [the evidence](evidence/auth-commit-backup-restore-local-2026-10-30.md).
A committed password change whose receipt
write fails produces an independently provable marker; R2 writes occur outside
the identity lock.

A separate child process is killed with SIGKILL after registration, before
COMMIT, after COMMIT, after checkpoint publication, after receipt publication
and after pending retirement. Evidence survives in PostgreSQL and a private,
fsynced single-writer filesystem fixture. Committed cases recover through the
actual active reconciliation path; registered/uncommitted cases quarantine.
This does not emulate hosted R2 concurrency or actual Worker termination.

Model tests cover canonical versus orphan history, immutable digest bindings,
limits and malformed ancestry. Recovery fault tests cover mixed known/unknown
operations, database changes during proof, concurrent registration/quarantine,
repeated CAS conflicts and lost successful receipt replies. Existing receipt
reconciliation tests remain in place.

## Rollout and daily-release compatibility

1. Apply additive migration 057 with writers disabled. It adds no required
   columns to existing tables and preserves legacy restore actions. Verify the
   old application against the expanded schema before enabling new behavior.
2. Deploy the recovery-capable reader with only its recovery flag enabled. Test
   restore from a pre-057 backup after applying 057, including real credential
   holds, session invalidation and canonical marker replay. A SQL function unit
   test alone does not prove the complete restore workflow.
3. Establish a rollback version that understands this protocol. Enable the
   writer only after isolated staging fault tests, exact fixture cleanup,
   continuity checks and compatible rollback succeed. Daily feature releases
   must retain this reader/restore floor and backward-compatible migrations.
4. To roll back a feature, disable new marker creation first while retaining
   the recovery reader and schema. Drain/reconcile eligible pending operations
   before considering a version without this reader. Older v1 receipt readers
   can read completed receipts, but cannot recover a marker-only interruption.
   Do not drop the marker table or restore function when rolling back a Worker.

The old journal component and pre-057 local backup compatibility are verified
in the linked drill. Still required: full old/new Worker compatibility, hosted
staging recovery and rollback, bounded request latency/cost under load,
and a reviewed production rollout. No production availability claim follows
from local tests. The shared control object's contention and truly unknown
multi-transaction operations remain separate reliability work.

The separate session-denial path and its hosted checks remain valid. This work
targets interrupted privacy transactions beyond that path; it does not replace
native-device, deployment, monitoring or measured monthly-availability gates.
