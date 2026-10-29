# Partitioned cleanup capacity: failed staging trial

Runtime `5bdf11fd74176175fce60b16b55c82c7f2d7b062`, active partition mode,
and a shared queue consumer cap of four did **not** pass the combined workload.
This result does not supersede the earlier serial trial's failure or establish
production readiness. Production writer, cleanup and partition flags remained
absent throughout this trial.

## Workload and failure

At 21:18:18 UTC on October 29, staging received 10,000 distinct synthetic users,
10,000 live sessions and 400 denied sessions with interleaved random identifiers.
Immutable denial authority was written and verified before SQL seeding. Ordinary
cron and queue delivery performed cleanup; no manual continuation was injected.

All 11 completed observations retained all 10,000 live sessions. Their maximum
user-journey duration was 2,537 ms. The last completed observation reported 184
denied sessions remaining. At 21:21:57.371 UTC, an independent protected-health
observation returned HTTP 503, `session_denial_pass_stale`, and oldest full-pass
age 306 seconds. The full-pass limit remained 300 seconds.

The main harness then failed with `PARTITION_PROGRESS_UNHEALTHY`. Its progress
reader threw before the failed cycle was persisted, so there is no synchronized
session count or journey result for that cycle. The independent health evidence
establishes the readiness failure; the 184 count belongs to an earlier sample.
Future harnesses must persist observations before applying acceptance assertions.

## Queue and workload observations

Cloudflare's queue telemetry returned these minute averages during the workload:

| UTC minute | Consumer concurrency | Queued messages |
| --- | ---: | ---: |
| 21:18 | 1 | 2 |
| 21:19 | 1 | 3 |
| 21:20 | 2.31 | 9 |
| 21:21 | 4 | 5 |

Returned ReadMessage lag averages were approximately 80, 67, 36 and 19 seconds
for minutes 21:19 through 21:22. The configured cap did not yield immediate
parallelism. These observations support delayed scaling as a contributor, not
a proven sole cause. Cloudflare documents scaling decisions between completed
batches, subject to backlog, errors and the concurrency cap:
[consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/).

Four ordinary cleanup completion events were observed. Application telemetry
also contained two denial retry observations; provider aggregates must not be
used to claim that no retries occurred. Paired timing observations attributed
approximately 87.5% of measured cleanup occupancy to authority reads. Separately
sampled phase aggregates cannot be added together as one complete invocation.

Connection snapshots were sparse. Pool open counters count cumulative physical
opens, including reconnects, rather than simultaneous connections. The observed
counter maximum of nine does not contradict the partition pool's configured
maximum of one, nor establish a leak. The telemetry does not prove a peak
connection bound or absence of brief refusals. It is not billing evidence.

## Cleanup and recovery

Exact owned SQL fixture cleanup verified zero remaining rows at 21:22:09 UTC.
The original recovery helper also stopped on stale progress. Read-only recovery
reconciled the same operation and confirmed zero rows without repeating SQL
cleanup. All three ranges subsequently completed fresh passes begun after
cleanup; the journal publication barrier was verified. Two new, durably recorded
post-cleanup user journeys passed. At 21:24:13 UTC, provider inventory was
unchanged and the shared lease was released. Immutable denials were retained.

## Next acceptance requirements

Investigate dedicated delivery for each fixed range, separated from ordinary
jobs. Admission must bound the total queue concurrency and database connections
across every consumer; adding three consumers on top of the existing cap is not
an adequate bound. Verify queue identity, range routing, continuations, duplicate
delivery, dead-letter handling, inventory reconciliation and rollback before
enabling such a topology. No new topology has been deployed by this evidence.

Repeat the same combined workload from an idle queue with unchanged freshness
limits, useful margin, all live sessions retained, healthy journeys, unrelated
job progress, connection measurements and exact cleanup. Artificially warming
consumer concurrency would not resolve the observed idle-to-burst failure.
Repair failed-cycle persistence first, preserving this original trial and its
one-shot operation records. Tracks #9 and #42; PR #90 remains draft.
