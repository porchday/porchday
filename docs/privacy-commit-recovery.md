# Independent proof of committed privacy transactions

Work in progress for #1 and #42. The read-only verifier and model tests exist;
there is no SQL writer, automatic reconciliation integration or deployment yet.
The existing quarantine and receipt rules remain authoritative. This is not an
operator command to clear a pending operation.

## Failure being addressed

Today, an auth transaction can commit and the Worker can stop before writing
its completion receipt. A later checkpoint can contain the committed privacy
decisions, but those decisions do not identify the registered operation. The
existing recovery code cannot infer that the whole operation finished. A
matching database cursor, elapsed time or a SQL completion row alone is
insufficient evidence after a restore.

The proposed protocol binds an independently registered single-transaction
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

The model tests cover restart from persisted records without a receipt;
registered-only, SQL-only and orphan-checkpoint states; legacy intents;
mismatched scope/intent/generation; duplicate markers; baselines and broken
ancestry; storage errors and work limits. They are not actual Worker termination,
PostgreSQL transaction or hosted storage tests.

## Remaining implementation and acceptance

- Add the backward-compatible migration, terminal event, transactional unique
  fence, least-privilege function grants and validated restore handling.
- Pass the registered proof scope only to the reviewed single auth transaction;
  prove that multi-transaction/social routes cannot accidentally opt in.
- Integrate recovery without changing the treatment of genuinely unknown
  commits, generation mismatch, database rollback or existing quarantine.
- Exercise real SQL rollback, duplicate attempts and concurrency, and terminate
  a separate process before/after COMMIT, checkpoint publication, receipt write
  and pending retirement. Keep durable evidence across the termination.
- Test restore with missing/rolled-back commit rows and canonical markers,
  wrong generations, conflicting CAS writes, lost storage replies, old/new
  executables and lost recovery-process replies. Never infer success from
  missing test observations.
- Review operation/read costs, bounded admission and checkpoint contention;
  this protocol alone does not remove the shared control object's bottleneck.
- Run isolated hosted staging recovery, exact cleanup and compatible rollback
  before a production proposal. Do not interrupt production to obtain proof.

The separate session-denial path and its hosted checks remain valid. This work
targets interrupted privacy transactions beyond that path; it does not replace
native-device, deployment, monitoring or measured monthly-availability gates.
