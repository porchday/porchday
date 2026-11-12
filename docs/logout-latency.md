# Logout and revocation latency

Investigation and release plan, November 12, 2026; implementation is not yet
production acceptance. Track [#55](https://github.com/porchday/porchday/issues/55).

The 24-hour Mac monitor window ending 15:57:25 UTC contains 4,320 probes.
Among successful checks, logout p50/p95/p99 were 3,843/5,102/6,455 ms;
revocation was 274/430/739 ms. Failed/censored requests are excluded from those
latency percentiles, not from availability. There were 18 unsuccessful logout
and 19 unsuccessful revocation checks, including dependent failures. The old
10-second shared journey timer could expire before revocation started.
Sampled server phases show journal registration, checkpoint, receipt and
retirement dominate ordinary logout; this does not explain every tail event.

The corrective rollout should use the existing immutable session-denial protocol
once current reader, cleanup, rollback and concurrency acceptance is established.
Publication must be confirmed before exact identity-locked SQL deletion; both
must finish before HTTP success. Unknown writes are never replayed. Global
read guards and other privacy mutations retain the recovery journal. New fixed
`denial_publish` and `denial_cleanup` phases distinguish remaining latency.
The two-second denial-read and four-second publication bounds remain unchanged.
Production activation is not implied by source presence or a staging flag.

Synthetic checks now receive independent operation budgets: 10 seconds for
login, reads and logout; 5 seconds for the post-logout old-cookie check. An outer
35-second cap bounds the sequential journey, with no overlapping probes or
catch-up bursts. This gives revocation time to establish its actual outcome even
when the single logout request timed out. An ambiguous logout remains failed,
even if a later old-cookie check returns 401. An accepted old cookie still fails.
All raw timings and failures remain recorded. Version-2 timing metadata also
records whether the former ten-second composite deadline was exceeded, so
historical comparison cannot silently classify those samples as unchanged.

These are conservative operational deadlines, not demonstrated 99.99th-percentile
latencies or a provider promise. A 99.99% monthly availability objective requires
its full measured denominator, failures and coverage gaps; isolated healthy
release checks cannot establish it. Review per-operation distributions and the
legacy composite exceedance count over the sustained watch before tightening.
Cloudflare documents [strong R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
and an [availability SLA](https://www.cloudflare.com/r2-service-level-agreement/);
these do not supply a numerical p99.99 operation-latency guarantee.

Release acceptance requires current denial-aware readers and rollback sources,
real old-cookie rejection with a retained SQL row, unrelated-session continuity,
scheduled exact cleanup after contention, bounded staging concurrency/capacity,
exact-source native and repository CI, and monitored staging/production rollout.
Never label an unperformed acceptance test passed or discard failed attempts.
