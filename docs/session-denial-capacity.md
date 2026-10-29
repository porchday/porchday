# Session denial cleanup capacity

The October 29 diagnostic run completed two passes over 10,003 SQL candidates in
234 and 245 seconds with all 10,000 synthetic sessions intact. All 27 journey
observations passed; exact fixture cleanup and unchanged provider state were
verified. Earlier runs failed the same readiness threshold. The maximum observed
full-pass age was 288 seconds against a 300-second limit, so this run does not
establish repeatable capacity margin or production readiness.

[Measured run](evidence/session-denial-timing-10k-staging-2026-10-29.json)
records independently sampled phase aggregates. Estimated mean authority batch
wall time was 92.05 ms, compared with 169.24 ms for one SQL discovery page and 216.01 ms
for one checkpoint write. At five concurrent reads, 100 candidates required 20
sequential authority batches. This makes authority reads the primary measured
candidate for improvement; it does not prove queue delivery latency or isolate
all sources of variation between runs.

## Six-read experiment

The next implementation increases only the authority-read batch from five to six.
Cloudflare documents a maximum of six connections simultaneously waiting for
response headers per invocation, including R2 operations. Requests beyond that
limit queue internally. SQL discovery finishes before authority reads start;
serial exact deletions and the checkpoint wait until the whole read batch has
finished. An already established idle database connection does not itself wait
for response headers under the documented limit.

[Cloudflare Workers connection limits](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections), checked October 29, 2026.

The page remains 100 candidates, each read retains its two-second observation
bound, and up to five pages share the existing 20-second work-start deadline.
Authority validation, exact identity-locked SQL deletion, partial-prefix
checkpoints, CAS continuation tokens and health thresholds are unchanged. Failed
or late reads cannot authorize deletion; no next batch starts after the deadline.
No new connections are opened concurrently for SQL deletion.

Six reads require 17 batches for a full 100-candidate page instead of 20. This is a
hypothesis for more margin, not a predicted hosted speedup. Validate the native
storage/SQL failure paths and repeat two complete hosted passes with the entire
10,000-session fixture intact. Record pass duration, peak observed freshness,
journey results, phase timing and exact cleanup. Retain earlier failed evidence.
Do not enable production writers based solely on this experiment: compatible
rollback, denied-backlog and interruption/concurrency acceptance remain required.

## Six-read hosted result

The six-read runtime completed two 10,003-candidate passes in 217 and 254 seconds
with all 10,000 synthetic sessions intact. All 29 journey observations passed;
exact cleanup, unchanged provider state and released lease were verified.
Maximum observed full-pass age was 273 seconds. [Evidence](evidence/session-denial-six-read-10k-staging-2026-10-29.json).

The mean 235.5 seconds is only 1.67% lower than the prior 239.5-second mean, and the
second pass was slower than either prior pass. These successive runs are not a
randomized comparison. Six reads alone have not demonstrated substantial,
repeatable capacity margin. Authority batches remain the largest measured
per-page cost; per-read latency distribution and the contribution of batch
barriers remain unmeasured. Keep the broader capacity and recovery gates open.


## Next measurement: paired batch occupancy

The next diagnostic change measures occupied and available read-slot time in the
same staging-only aggregate point. This avoids dividing independently sampled
phase totals and tests whether batch barriers leave substantial unused capacity.
Successful batches alone contribute; failures remain in the existing phase timing.
Read concurrency, deadlines, SQL deletion ordering, checkpoints and health thresholds
stay unchanged. Local tests exercise unequal read latencies, partial batches and
late completion after failure. Hosted occupancy and any resulting throughput change
are not yet measured. Do not infer a capacity improvement from instrumentation.


## Paired occupancy result and freshness sampling gap

Staging runtime `119dff0` completed two full 10,003-candidate scans in 198 and
259 seconds, with all 10,000 synthetic sessions intact. All 28 sampled journeys
passed. Exact cleanup verified zero fixture rows, unchanged provider state and
released lease. [Evidence](evidence/session-denial-occupancy-10k-staging-2026-10-29.json).

The bounded load window yielded 48 paired occupancy points: 1,360,090 occupied
slot milliseconds out of 2,028,804 available, or 67.04% occupancy, across 20,706
observed reads. About 32.96% of observed slot time waited for the rest of its batch.
Only successful batches contribute; partial batches count actual reads. These
measurements support evaluating bounded refilling of the existing six read slots,
with serial deletion after reads settle. They do not predict a throughput gain
or establish the safety of a different scheduler. Preserve deadlines, failed-read
behavior, exact-prefix checkpoints and the platform connection limit in any trial.

The sampled trial result is not sufficient capacity acceptance. The inferred gap
between the two completed passes exceeds 300 seconds even though no sampled
readiness response failed. Intersecting request intervals with floored pass ages,
including one millisecond of clock padding, yields 301.974–303.584 seconds under
a stable server/client clock-offset assumption. Exact persisted completion times
were not captured, so this remains a timing inference, not a directly recorded
stale response. Future acceptance must capture those timestamps and verify the
interval between full passes, in addition to journey probes and scan duration.
Do not relax health thresholds or relabel this run as repeatable freshness margin.


## Exact completion acceptance

`scripts/session-denial-capacity-proof.ts` now provides the additional acceptance
check. Read the actual v3 progress object under the trial's deployment lease,
parse it with `exactCandidateProgress`, and persist the sanitized result before
passing it to `CandidateCapacityProof`. The parser validates the full stored
shape but excludes the session cursor from retained evidence. A read-only staging
check confirmed that the operator storage API returns these exact timestamps;
no Worker or schema change is required.

Capture a healthy baseline before seeding, then construct the proof with the
confirmed fixture commit time. Every observation must remain healthy and
monotonic. Every newly observed full-pass completion must be within 300,000
milliseconds of the preceding completion, including the baseline-to-first interval.
A failure permanently invalidates that proof. Acceptance requires two completed
passes that began after fixture commit and each saw at least the full fixture size.
Repeated reads of one pass cannot satisfy the requirement.

The operator harness still must verify intact fixture rows, authenticated journeys,
provider/source pins, exact cleanup and recovery. This helper does not establish
continuous page freshness or unsampled user availability. A missed intermediate
completion can cause conservative rejection; never interpolate or manufacture it.
The hosted bounded-refill result below uses exact reads and this proof.
Tests reproduce the 302.518-second gap
missed by periodic probes and enforce the exact 300,000-millisecond boundary.


## Bounded read-slot refill experiment

The next runtime keeps six reads active by refilling a slot as soon as its read
settles, within groups of at most 24 candidates. It waits for all started reads
in that group before processing candidates in SQL keyset order. SQL cleanup
remains serial and does not overlap authority reads; the next group starts only
after that processing finishes. No page size, schema, progress format or health
threshold changes.

The two-second bound on each read and the shared 20-second work-start deadline
remain. A failure stops refilling, rejects the group and prevents its SQL work or
checkpoint; late completions cannot resume it. Completed earlier groups can
still provide a processed prefix when a later group reaches the deadline.
Read-ahead IDs that were not processed never advance the checkpoint. Bounded
groups avoid prefetching an entire page before any prefix can make progress.

This is an experiment motivated by the measured 32.96% waiting time, not a
predicted throughput improvement. Validate native storage/SQL behavior and the
new exact full-pass interval verifier before hosted acceptance. Keep the full
10,000-session fixture intact through two passes, capture paired occupancy and
phase evidence in one pinned-runtime window, and reconcile exact cleanup.


## First bounded-refill trial with exact completion timestamps

Staging `2120ff4c`, runtime `8634c17`, passed the strict two-pass trial with
10,000 synthetic sessions intact. Each completed scan saw 10,003 candidates;
exact durations were 125.272 and 206.815 seconds. Completion intervals, including
the healthy pre-seed baseline, were 185.052 and 255.657 seconds. The largest
interval had 44.343 seconds of margin against the unchanged 300-second threshold.
All 22 sampled authenticated journeys passed. Maximum sampled page/pass ages
were 53/248 seconds. Exact fixture cleanup left zero rows, provider and canonical
state stayed unchanged, and the deployment lease was released. No production
mutation, manual sweep or progress write contributed to the result.
[Sanitized evidence](evidence/session-denial-refill-10k-staging-2026-10-29.json).

The 125-to-207-second variation matters: this single run does not establish
repeatable headroom. Exact timestamps close the prior sampling gap for these
observed full-pass intervals; they do not prove continuous page freshness or
unsampled user availability. All synthetic sessions belong to one member, and
none represents a large denied backlog. Repeatable capacity, mixed pilot load,
backlog recovery and operating-cost acceptance remain separate gates.

Paired occupancy is retained in the evidence with its bounded query window and
collection time. Available slot time now means group wall time times configured
workers (up to six), with groups up to 24 candidates; occupied time sums actual
read observation durations. Only successful groups contribute. This differs
from the prior batch accounting, and independently sampled phase totals cannot
be added or divided to infer a speedup. The two runs were not a randomized
performance comparison.
