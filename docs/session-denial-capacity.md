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
