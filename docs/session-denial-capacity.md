# Session denial cleanup capacity

The October29 diagnostic run completed two passes over10,003 SQL candidates in
234 and245 seconds with all10,000 synthetic sessions intact. All27 journey
observations passed; exact fixture cleanup and unchanged provider state were
verified. Earlier runs failed the same readiness threshold. The maximum observed
full-pass age was288 seconds against a300-second limit, so this run does not
establish repeatable capacity margin or production readiness.

[Measured run](evidence/session-denial-timing-10k-staging-2026-10-29.json)
records independently sampled phase aggregates. Estimated mean authority batch
wall time was92.05ms, compared with169.24ms for one SQL discovery page and216.01ms
for one checkpoint write. At five concurrent reads,100 candidates required20
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

[Cloudflare Workers connection limits](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections), checked October29,2026.

The page remains100 candidates, each read retains its two-second observation
bound, and up to five pages share the existing20-second work-start deadline.
Authority validation, exact identity-locked SQL deletion, partial-prefix
checkpoints, CAS continuation tokens and health thresholds are unchanged. Failed
or late reads cannot authorize deletion; no next batch starts after the deadline.
No new connections are opened concurrently for SQL deletion.

Six reads require17 batches for a full100-candidate page instead of20. This is a
hypothesis for more margin, not a predicted hosted speedup. Validate the native
storage/SQL failure paths and repeat two complete hosted passes with the entire
10,000-session fixture intact. Record pass duration, peak observed freshness,
journey results, phase timing and exact cleanup. Retain earlier failed evidence.
Do not enable production writers based solely on this experiment: compatible
rollback, denied-backlog and interruption/concurrency acceptance remain required.
