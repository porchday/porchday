# Session cleanup batching: staging acceptance, October 29

Runtime `3c0c7e2fedee59d2b4e7ffa5663e5308b518b2fc` passed guarded staging
activation as version `dfb52ebb-ed51-4ff4-bb99-736de78fbfc0`. All six exact-source
CI checks passed. The rollout recorded 12 continuity samples, zero failures and
two samples after activation. An existing signed-in session remained usable and a
revoked session remained rejected. All rollout fixtures were removed and provider
state was reconciled. Production was unchanged.

The subsequent trial created 100 synthetic members, each with four denied
sessions and one live SQL session. Random UUIDs interleaved members in the scan.
All 400 immutable denial records were confirmed before a single transaction
seeded the 500 sessions. Scheduled cleanup ran normally: no manual sweep, queue
injection or progress write accelerated it. Separate authenticated user journeys
ran every 20 seconds with the existing deadline.

Results:

- All 400 denied sessions drained in **283,034 ms** from the confirmed seed.
- All 100 live sessions remained until exact fixture cleanup.
- All 15 user-journey samples passed; the slowest was 5,857 ms.
- The observed full-pass completion interval was **279,079 ms**, leaving only
  about 21 seconds below the unchanged 300-second pass-freshness threshold.
- Maximum sampled page and pass ages were 144 and 264 seconds respectively.
- Exact cleanup left zero SQL fixture rows. Immutable denials were retained.
  Recovery checks passed, provider state stayed unchanged, and the lease released.

This is a small backlog acceptance result with insufficient capacity margin. It
is not a 10,000-member workload, a combined 10,000-live-session plus denied-backlog
trial, or a production performance comparison. Keep PR #90 in draft pending more
throughput work and representative validation. Do not enable production denial
writes or relax deadlines based on this result.

Sampled phase telemetry in the load window included five SQL-deletion points,
with weighted estimates of 183,204 ms across 33 batch attempts. This identifies
SQL cleanup as the next area to investigate, but separately sampled phase totals
must not be added or divided into a request-level breakdown. Missing progress-write
points do not mean no checkpoint was written: direct checkpoint observations prove
progress. For this candidate, `sql_delete` attempt counts represent batch calls,
not session counts or SQL statement counts.

An earlier operator fixture-preparation attempt failed before SQL seed. Four
immutable writes had succeeded, but the REST adapter rejected weak ETags on their
reads. Read-only reconciliation confirmed all four exact canonical objects. The
corrected drill uses a separate immutable reader that verifies canonical bytes and
rejects checkpoint keys; checkpoint/CAS reads retain strong-ETag enforcement. The
original failed attempt remains recorded and was not replayed.

[Machine-readable evidence](denial-cleanup-batch-staging-2026-10-29.json).
