# Combined session cleanup capacity: failed staging acceptance

Runtime `3977665547d4e7e52fd14c068a966f9299a2c882` was activated as staging
version `3bec9135-d0e7-4677-a84e-f92f3cdf8d07` on October 29, 2026. All six exact
revision CI checks passed. Guarded activation passed 12 continuity samples with
zero failures, including existing allowed and revoked sessions and two samples
after activation completed. Activation fixtures were removed and provider state
reconciled. Production was unchanged.

## Workload and failure

The trial used 10,000 synthetic auth identities, each with one live session, plus
400 denied sessions across 400 distinct identities. Random session UUIDs mixed
denials into the live-session scan. All 400 immutable denial authorities were
written once and verified before SQL seeding. Only ordinary scheduled cleanup
and its queue continuations processed the backlog; no manual sweeps or progress
writes accelerated it.

At the fourteenth observation, protected readiness returned 503 with
`session_denial_pass_stale`: the previous completed pass was 313 seconds old,
above the existing 300-second limit. The current pass had checked 6,872
candidates. 152 denied sessions remained and all 10,000 live sessions remained.
The page checkpoint was only four seconds old; useful progress continued, but
full-pass throughput was insufficient. The latest full pass before seeding was
already about 51 seconds old. The failure occurred about 263 seconds after seed.

Login, feed/profile reads, logout and revocation checks passed in that failed
observation. Across 14 observations, 13 complete journey/readiness probes passed;
the maximum total probe duration was 2,299 ms. The only observed health issue was
stale full-pass cleanup. Do not describe this as successful combined capacity or
relax the health limit to turn it into a pass.

## Cleanup and recovery

The harness removed only its exact owned SQL fixtures, leaving zero fixture rows.
Journal capture remained enabled: removal of the 10,000 identities generated
required safety decisions. Six recovery observations established healthy journeys,
a fresh full pass begun after cleanup, and an active journal published through
the post-cleanup SQL sequence. Provider state was unchanged by the load trial and
the shared deployment lease was released. Immutable denials remain retained.

The actual large-fixture SQL had first passed on local PostgreSQL 17: 263 ms seed,
726 ms cleanup, 10,000 captured journal decisions and zero remaining rows. Those
local durations are not hosted performance evidence.

## Diagnosis and remaining acceptance

Sampled phase telemetry during the workload included authority reads, SQL deletion,
SQL listing, checkpoint reads/writes and queue sends. Authority-read invocation
p95 was 13,697 ms and SQL-delete invocation p95 was 5,177 ms in their respective
sample sets. These independently sampled aggregates cannot be added or divided
into a request-level time breakdown, and they do not establish queue delivery
latency. Paired authority slot telemetry observed 18 points with 85.9% occupancy
(833,858 occupied slot-ms / 970,948 available slot-ms). That suggests limited
headroom from simply filling idle read slots; it is not a service-time or speedup
prediction. Direct progress observations establish the capacity failure.

The setup optimization reduced SQL client query calls and passed hosted activation,
but it has not made this combined workload meet the freshness requirement. Keep
production denial writer/cleanup disabled and PR #90 in draft. Further throughput
work must preserve independent denial authority, owner rechecks, per-member lock
boundaries, confirmed-prefix behavior, deadlines, journal capture and safe cleanup.
Repeat a representative combined workload with useful margin before promotion.

This is session-cleanup capacity evidence, not 10,000 simultaneous application
users, physical-device acceptance, or proof of 99.99% monthly availability. The
smaller 100-member successful trial remains separate evidence. Tracks #9 and #42.
