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

The core is not yet connected to cron, queue delivery or operational health. It
has not been deployed and does not establish throughput improvement.

## Required integration and admission

1. Bound queue consumer concurrency before enabling parallel partitions. The
   current verified queue has batch size one and no explicit concurrency cap.
   Plan a cap of four concurrent invocations on the shared staging jobs queue,
   then verify actual database connection usage and expiry/email progress under
   load. This is a proposed cap, not a deployed setting or demonstrated capacity.
   Duplicate deliveries must remain bounded by that cap; CAS alone only prevents
   conflicting checkpoint publication and does not prevent duplicate SQL work.
2. Add explicit disabled, shadow and active modes. Disabled mode retains current
   behavior. Shadow mode initializes independent v4 evidence alongside v3 on a
   small staging fixture. Only after every v4 range is verified should active mode
   replace v3 scheduling and readiness. Invalid mode/partition values must fail
   closed. Old queue messages and stale continuation tokens must not fan out.
3. Keep authority reads at six per invocation, SQL serial within each invocation,
   per-member lock release, and the existing 20-second work-start budget. Send at
   most one continuation for the selected range after its successful CAS. Cron
   starts exactly the three fixed ranges; it does not derive new ranges from
   queue payloads. A lost send is recovered through ordinary cron resumption.
4. Give each partition an invocation-local pool that uses no more than one SQL
   connection. The queue cap must cover duplicates and overlapping cron ticks,
   not just the three nominal ranges. Do not raise existing shared pool limits.
5. Verify rollback compatibility explicitly. A retained v3 checkpoint can become
   stale after active mode stops v3 scheduling; merely retaining its bytes does
   not prove an old worker would immediately pass readiness. Activation and
   rollback evidence must account for mode, queue settings and progress freshness.
   Never fabricate fresh checkpoints to make a rollout pass.

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
hosted plan or latency measurement. No runtime integration, parallel-capacity
claim, production change or new resource setting is included in these results.
