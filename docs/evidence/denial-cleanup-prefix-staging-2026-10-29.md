# Confirmed cleanup-prefix progress: staging validation

Runtime `15af2c28e7983d3d10d1bff976bc45dc4de9a859` passed all six exact-source
CI checks and guarded staging activation as
`211e3158-08a5-4a5b-add3-8cf410d0054e`. The activation recorded 11 continuity
samples, zero failures and two samples after activation. Existing signed-in and
revoked-session behavior remained correct. Rollout fixtures were removed and
provider state reconciled. Production remained unchanged.

The workload again used 100 synthetic members, each with four independently
confirmed denied sessions and one live SQL session. Scheduled cleanup ran
normally; no manual sweep, queue injection or progress write accelerated it.

| Observation | Earlier batching runtime `3c0c7e2` | Prefix runtime `15af2c2` |
| --- | --- | --- |
| Denied sessions drained | 400 | 400 |
| Live sessions retained | 100 | 100 |
| Seed to observed complete drain | 283,034 ms | 242,671 ms |
| First observed checkpoint advance after seed | 163,067 ms | 84,500 ms |
| Maximum sampled page age | 144 seconds | 64 seconds |
| Observed full-pass completion interval | 279,079 ms | 238,389 ms |
| Successful user journeys | 15 of 15 | 13 of 13 |
| Maximum observed journey duration | 5,857 ms | 3,453 ms |

Both trials seeded about two seconds after the previously observed full pass,
but initial cleanup delivery differed: the first observed deletion occurred at
63 seconds in the earlier trial and 85 seconds in the revised one. Random IDs,
queue delivery and provider conditions also differed. Twenty-second sampling
limits timing precision and can miss intermediate completed passes. These are
separate workload trials, not a controlled causal percentage-speedup benchmark.

The revised trial demonstrates checkpoint advancement during bounded cleanup and
more observed freshness margin for this workload. Its final fresh pass saw 103
remaining sessions, including all 100 live fixture sessions. Exact fixture cleanup
left zero SQL rows; immutable denials were retained. Recovery journeys and a new
scheduled full pass passed before the lease was released. Provider state stayed
unchanged.

All eight phase types appeared in the sampled load-window telemetry. SQL-deletion
invocation p95 was 19,304 ms across six observed points; this remains a reason to
reduce SQL round trips. Phase totals are independently sampled and must not be
combined into an invocation breakdown or used to claim precise time savings.

Keep the PR in draft pending further throughput work and representative combined
live-session/backlog validation. This 100-member trial does not establish pilot
capacity, production denial-writer readiness or 99.99% monthly availability. No
schema, dependency, production flag or deadline was changed.

[Machine-readable evidence and comparison](denial-cleanup-prefix-staging-2026-10-29.json).
