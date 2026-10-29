# Bounded partitioned session cleanup

The combined staging trial in
[evidence/denial-cleanup-combined-staging-2026-10-29.md](evidence/denial-cleanup-combined-staging-2026-10-29.md)
failed the existing five-minute full-pass freshness requirement. All live sessions
survived, but 152 of 400 denied sessions remained among 10,000 live sessions when
readiness failed. Smaller healthy-only and denied-only trials do not establish
combined capacity. Another small SQL round-trip reduction is unlikely, by itself,
to provide enough margin; that is an engineering assessment, not a benchmark.

## Implemented core

`session-denial-partitions.ts` defines three fixed, disjoint SQL text ranges:

| Partition | Inclusive lower bound | Exclusive upper bound |
| --- | --- | --- |
| 0 | none | `5` |
| 1 | `5` | `a` |
| 2 | `a` | none |

PostgreSQL compares both range bounds and cursors using its existing collation.
There is no JavaScript sorting assumption, UUID-only filter, hash-table scan or
new index. Malformed identifiers remain candidates for the existing validation
path. A foreign-range cursor fails; it cannot produce an empty successful pass.
Each list transaction retains the read-only setting, five-second statement
limit, six-second client query limit and 100-candidate page bound.

A narrow adapter reuses the existing confirmed-prefix, immutable-authority and
CAS engine while persisting independent v4 range checkpoints. Their bodies name
the version, strategy and exact partition. The adapter never reads or writes the
real v3 checkpoint, rejects cross-partition bodies, permits only exact authority
reads, and refuses unrelated writes. Failed/unknown SQL and checkpoint outcomes
retain existing handling. No concurrent per-member transactions or broader
runtime connection pools have been added by this core.

Aggregate health requires all three ranges. It uses the oldest page/pass age,
reports any slow or invalid range, and retains the existing 180-second page and
300-second pass limits. A busy range cannot conceal a stalled or missing range.
Reported counts summarize separate range passes, not a transactional snapshot of
all sessions at one instant.

The core is now connected to cron, queue delivery and operational health through
`session-denial-runtime.ts`. The mode binding is absent by default, preserving v3
behavior. Staging has completed shadow, dual and active transitions. The
[partitioned combined trial](evidence/denial-partition-combined-staging-2026-10-29.md)
also failed freshness under load; partitioning with a shared queue cap of four
does not establish sufficient hosted capacity.

## Runtime integration and required deployment admission

1. Bound queue consumer concurrency before enabling parallel partitions. The
   staging queue has batch size one and a verified concurrency cap of four.
   Production still has no explicit cap; its partition mode remains absent.
   Both Wrangler source configs specify four, but source settings alone do not
   establish deployed state.
   Verify the deployed cap before enabling the mode, then measure database
   connection usage and expiry/email progress under load. Source configuration
   alone is not admission evidence.
   Duplicate deliveries must remain bounded by that cap; CAS alone only prevents
   conflicting checkpoint publication and does not prevent duplicate SQL work.
2. `SESSION_DENIAL_PARTITIONS_V1` implements disabled (also the absent default),
   shadow, dual and active modes. Shadow runs independent v4 ranges alongside v3
   on a small staging fixture; readiness remains v3 during initialization. Dual
   keeps both schedulers running but requires all three v4 ranges for readiness.
   Promote shadow to verified dual before activating v4 alone, so the preceding
   dual version remains a rollback target even when v3 progress ages out. Active mode
   replaces v3 scheduling and requires every v4 range for readiness. Invalid
   modes, or partition opt-in without cleanup enabled, fail closed. Obsolete v3
   deliveries in active mode and v4 deliveries in disabled mode are acknowledged
   without restarting their namespaces. Only after every v4 range is verified
   should the operator activate the new mode.
3. Keep authority reads at six per invocation, SQL serial within each invocation,
   per-member lock release, and the existing 20-second work-start budget. Send at
   most one continuation for the selected range after its successful CAS. Cron
   starts exactly the three fixed ranges; it does not derive new ranges from
   queue payloads. A lost send is recovered through ordinary cron resumption.
4. Each partition uses an invocation-local pool with `max:1`, closed on both
   success and failure. Existing shared pool limits are unchanged. Continuation
   tokens include the version and partition; cross-range tokens fail before SQL.
   Queue sends have a five-second reply bound and late replies do not cause a
   local resend. Cron attempts all fixed sends and reports any failure. The
   deployed queue cap must cover duplicates and overlapping cron ticks, not just
   the three nominal ranges.
5. Verify rollback compatibility explicitly. A retained v3 checkpoint can become
   stale after active mode stops v3 scheduling; merely retaining its bytes does
   not prove an old worker would immediately pass readiness. Activation and
   rollback evidence must account for mode, queue settings and progress freshness.
   Never fabricate fresh checkpoints to make a rollout pass. The dual transition
   addresses stale legacy progress, but cannot hide a missing or corrupted v4
   range; both dual and active must fail those cases. Hosted rollback testing
   remains required.

Cloudflare documents six requests waiting for response headers per invocation;
separate invocations have separate limits. Queue concurrency can be explicitly
capped, and autoscaling decisions occur between completed batches. These facts
support investigating bounded partitions; they do not promise three-way parallel
execution or a threefold speedup. Sources:
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/) and
[Queue consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/),
checked October 29, 2026.

## Acceptance before production

Exercise duplicate/lost delivery, stale and cross-range tokens, CAS loss, partial
SQL success, unknown commits, process interruption, invalid/future progress,
missing/stalled ranges, restore behind each cursor, and boundary identifiers.
Prove SQL ordering and range coverage with the restricted auth role. Preserve
journal capture and exact fixture cleanup. Check that range predicates use the
existing index on representative data rather than assuming a query plan.

Use guarded staging code and mode transitions with existing allowed/revoked
sessions and old/new client continuity. Repeat the combined 10,000-distinct-user,
10,000-live-session and 400-denial workload under normal cron/queue delivery.
Require every range to stay fresh with useful margin, every live session retained,
healthy user journeys, bounded connection usage, unrelated job progress, and
post-cleanup journal publication. Retain any failure evidence; do not relax the
freshness limits or substitute a smaller workload.

Measure R2 operations, SQL activity and queue invocations before estimating costs.
The total candidate population per full pass stays the same, but overlaps,
continuations, health reads and duplicate work can add operations. No new paid
service or capacity commitment is authorized by this design. Production writers
remain disabled until capacity and the remaining failure/concurrency/device gates
are verified. Tracks #9 and #42; PR #90 remains draft.

## Local validation on October 29

The focused PostgreSQL/partition/candidate suite passed 62 tests. The full API
suite passed 522 tests with one skipped; typecheck, formatting and secret checks
passed. PostgreSQL coverage compared the combined range output with the database's
complete ordering across 400 random UUIDs and boundary/non-UUID identifiers.
Foreign cursors failed and later valid queries recovered.

A separate disposable PostgreSQL 17 database held 10,000 synthetic sessions.
EXPLAIN of the six actual helper query texts and parameters (first and resumed
page for each range), executed through the restricted auth role, used the existing
`auth_session_pkey` index in every case. This is local planner evidence, not a
hosted plan or latency measurement. No hosted parallel-capacity claim, production change or applied provider setting
is included in these core results.

The runtime integration focused suite passed 102 tests, including a restricted-role
PostgreSQL run of three partitions plus an overlapping duplicate. It deleted all
420 denied sessions, retained all 12 live sessions and completed independent v4
checkpoints without creating v3 evidence. Unit and worker-route tests cover mode
transitions, obsolete deliveries, scoped tokens, send failure/timeout, pool cleanup
and missing/stalled range health. This local overlap test does not establish the
provider's consumer cap, hosted throughput, other-job fairness or rollback safety.

The integrated full API suite passed 542 tests with one skipped (57 files).
Typecheck, formatting, secret and diff checks also passed. The source deployment
configs specify the consumer cap; no queue setting, mode flag or worker version
was changed by this local validation.

## Staging code deployment and queue admission tooling

Runtime `c570e740b0d272eab226d596fb07d47a8e5e7a15` passed all six push/PR
CI checks and was activated as staging version
`3216c7be-bda5-4818-bc90-26eb4f9b47ee`. The original continuity observer
recorded nine healthy samples, but its command ended attention-required before
release verification started. That observed activation acceptance remains
incomplete; it must not be reported as a clean continuous rollout.

Read-only reconciliation confirmed the original candidate deployment and operation
identity. The maintained recovery controller resumed the same journal, passed the
application journey and assets, and finalized the candidate without reactivating
it. Subsequent reads confirmed the retained allowed session, revoked-cookie denial
and operational readiness. The remaining synthetic session was logged out once;
both synthetic accounts were removed and zero fixture rows verified. Provider
inventory remained unchanged and the shared lease was released. Production was
unchanged. Two production monitor timeouts in the same interval recovered on the
next probe; temporal overlap does not establish their cause.

`queue-admission-lease.ts` adds a durable settings-change protocol using the same
SQLite kernel lock and persistent marker as deployments. It records intent before
a single send, reconciles exact provider inventory after an uncertain reply, and
writes a finalization receipt before atomically updating the canonical snapshot
reference. All unrelated canonical fields remain fixed. Recovery resumes the
original intent and receipt; it never resends an unknown mutation. Tests cover lost
replies, crash boundaries, inventory drift, lock exclusion and proof corruption.
The lease and existing upload/deployment suites passed 43 tests, with typecheck,
formatting, secrets and diff checks passing. This is tooling validation only: the
provider concurrency cap was subsequently applied to staging only. Later staging
mode transitions are recorded below; production partition mode remains absent.

At 21:02:55 UTC, the queue settings operation completed after all six exact-source
CI checks passed for `60b681eaea9fd3a83ddab2315c1c346a97a60a1a`. Full provider
readback matched exactly one intended change: staging consumer concurrency four.
The canonical inventory reference was finalized, the shared lease released, and
staging readiness plus fresh production monitor checks passed. Worker versions,
production settings, retry policy and dead-letter routing were unchanged.
[Provider update API](https://developers.cloudflare.com/api/resources/queues/subresources/consumers/methods/update/)
was checked before the once-only request. This does not prove load capacity.

The dual transition mode was implemented after this queue change in runtime
`5bdf11fd74176175fce60b16b55c82c7f2d7b062`. The 53 focused tests
and API typecheck/format/secret/diff checks passed. Its tests cover
both queue namespaces, fixed scheduling, strict range health and bounded reads,
including active-to-dual recovery with unavailable legacy progress. Stale or
missing v4 ranges still fail readiness. All six exact-source hosted CI checks
passed. Guarded shadow activation passed 15 continuity samples, then dual and
active each passed 11; all had zero failures and two post-terminal samples.
Each transition verified existing allowed/revoked sessions, zero fixture rows,
reconciled provider inventory and a released lease.

Following the failed combined trial and verified cleanup/recovery, a controlled
active-to-dual return completed at 21:28:18 UTC. Legacy v3 full-pass age was
714,228 ms before activation. All 11 continuity samples passed, including two
post-terminal samples; exact fixture cleanup and provider reconciliation passed.
This demonstrates transition compatibility with stale legacy progress, not an
injected failure or a newly triggered automatic rollback. It does not make the
failed capacity trial acceptable. Production remains unchanged.

A separate guarded restoration to active mode completed at 21:29:47 UTC as
`bccd8e63-aa45-4af6-a125-328207f710a6`, using the same verified runtime bundle.
All 10 continuity samples passed, including two post-terminal samples. Exact
fixture cleanup verified zero rows, provider inventory was reconciled and the
lease released. The controlled return and restoration are complete; capacity
and the remaining failure/device gates are still open.

## Isolated delivery implementation, not yet deployed

The failed shared-queue trial showed concurrency averaging one during its first
two workload minutes despite a cap of four. `session-denial-delivery.ts` adds an
explicit `SESSION_DENIAL_QUEUE_TOPOLOGY_V1=isolated` opt-in. The absent default
remains shared delivery. All three producer bindings are required before any
partition send: `DENIAL_RANGE_0`, `DENIAL_RANGE_1`, and `DENIAL_RANGE_2`. Fixed
queue names are `porchday-<environment>-denial-0` through `-denial-2`.

Cron and continuation sends use the selected range's binding. Provider-supplied
queue identity must agree with the message's range before application work.
Unrelated or cross-range payloads fail on their original queue's retry and
dead-letter path. Old shared-queue range messages are acknowledged after switching
to isolated delivery; cron resumes their persisted ranges on the new queues.
Switching back to shared delivery drains dedicated-queue messages as obsolete.
Neither direction changes checkpoints or replays a payload onto another queue.
The dual/active readiness contract and all freshness/work limits remain unchanged.

Admission must verify **one concurrent consumer per range and one for ordinary
jobs**, batch size one, retry/dead-letter settings, every producer binding and
all queue identities. The existing jobs cap must be reduced from four before
activating the additional consumers. Four queue invocations do not mean four
database connections: each range pool allows one, while ordinary identity cleanup
can allocate an outer journal pool of one, its own jobs pool of one, and an auth
pool of three. That gives a conservative queue-pool ceiling of eight for this
path, excluding HTTP requests, cron, operators and provider pooling. Verify those
other sources and physical connection occupancy before admission; this source
calculation alone does not establish safe total database usage.

The pinned deployment tooling still covers only the two ordinary queues. The
source reader now accepts explicit identities for each fixed range and existing
dead-letter queue, rejects unregistered producer bindings, and requires complete
consumer/producer lists. Upload manifests validate the registry before acquiring
a lease. The reader's optional second CLI argument is an absolute private registry
JSON path; omitting it retains the existing two-queue configuration.

A separate bounded account catalogue reads every reported page and rejects
duplicates, changing totals, incomplete pages and incomplete consumer lists.
Admission must compare catalogue reads around its scoped inventory; pagination
is not an atomic provider snapshot. This makes unregistered queues visible when
checking total consumer concurrency and reconciling an unknown create outcome.
The [provider list API](https://developers.cloudflare.com/api/resources/queues/methods/list/)
was checked on October 29. A GET-only hosted check found exactly the two ordinary
queues and their dead-letter queues, matching the expanded scoped snapshot;
both dead-letter queues had zero consumers. Existing canonical inventory was
unchanged. No canonical metadata was rewritten by this read-only check.

Promote the verified reader to the pinned tooling and finish durable resource
creation/admission reconciliation before enabling additional queues. Queue IDs
are provider-assigned: never resend an unknown create request under a new operation
or assume its missing reply means failure. The rollback baseline must contain
delivery-aware code and retain all producer bindings. No provider queue, binding,
consumer cap or topology flag has changed as part of this implementation. Dedicated
queues do not guarantee delivery latency; repeat the unchanged combined workload
from idle, with connection and ordinary-job evidence, before claiming capacity.

`scripts/denial-capacity-observation.ts` preserves each bounded observation before
acceptance assertions, including partial reads and stale-range details. It retains
per-read start/end times so sequential observations are not described as one
transactional snapshot. A failed save propagates without retrying the journey or
other operations. Future workload runners must use this collector and the shared
runtime health calculation; the original failed trial and its proofs stay intact.
