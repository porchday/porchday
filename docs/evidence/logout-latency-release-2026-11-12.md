# Logout latency and revocation deadline correction

Production activation, contention acceptance and initial latency watch passed. Tracking: [#55](https://github.com/porchday/porchday/issues/55).

## Cause and measurement

In the 24 hours ending November 12 at 15:57:25 UTC, 4,320 independent probes
included 23 failed probes. Successful logout checks had p50/p95/p99 of
3,843/5,102/6,455 ms; successful revoked-cookie checks were 274/430/739 ms.
Failures and censored durations remain in the history and are not included in
those successful-check percentiles. These are synthetic observations, not
continuous uptime or representative phone measurements.

Per-request server summaries corroborate journal overhead: one confirmed
5,475 ms logout spent 1,261 ms in registration, 2,656 ms in checkpointing,
389 ms in receipt publication and 444 ms in retirement; its transaction work
was 461 ms. Other slow summaries showed registration dominating instead.
This explains ordinary logout overhead, not every provider/network tail event.

The monitor compounded this by sharing a ten-second timer across login,
authorized reads, logout and revoked-cookie verification. A late logout could
leave no opportunity to observe the revoked cookie. That is not evidence that
an old cookie was accepted.

## Changes and safety

The server rollout uses independently durable session denial before exact,
identity-locked SQL cleanup. Success still requires both. Denial remains effective
when SQL cleanup is blocked or the original SQL row returns. Other privacy
mutations retain the global journal; authorization results are not cached.
Production cleanup is upgraded to bounded SQL-session discovery, with durable
progress, conditional continuation and health checks. Discovery does not grow
with immutable logout history.

The six denial/cleanup modules match the earlier 10,000-session validated runtime
byte for byte. That historical test completed two actual scheduled passes in
204.221 and 226.230 seconds with 25 healthy journeys. This release reuses that
unchanged-code evidence; it does not claim a new load test, pilot-scale denied
backlog acceptance or a measured capacity percentile. Production had 32 session
rows at the investigation snapshot.

The external monitor gives operations independent deadlines: ten seconds for
login/reads/logout, five for revoked-cookie verification, with a 35-second outer
cap and no overlapping probes. Logout is never retried. A failed logout remains
failed even if the following cookie check returns 401. Raw history retains timing
policy version and the former composite-deadline exceedance indicator; availability
reports disclose mixed policies. Existing historical failures and unknown coverage
are not erased. Aggregate API-error and feed-latency alert thresholds are unchanged.

## Staging evidence

Runtime `5215e1dc0fb9cbc871f2fd87e6806ecbe45f92b7` activated as
`62f9cdfd-ddb1-43fd-9f2e-c38d4b7bc97f`, preserving the staged partitioned cleanup
and current photo behavior. Seventeen continuity samples passed, including two
after activation completed. Exact synthetic fixture cleanup was verified.

Normal logout took 1,101 ms and 1,059 ms in the scoped acceptance test, cleared
the cookie and removed the exact SQL session. Forced synthetic identity-lock
contention returned the expected 503 after 6,880 ms; the old cookie was denied
while its SQL row remained, and another session stayed usable. Scheduled cleanup
removed the row within 5,088 ms after the lock was released. No manual sweep
contributed. Protected readiness passed; exact fixture cleanup left zero rows.
This forced failure is retained, not counted as successful logout availability.

## Production activation

Exact runtime `0d7966cb83b85a8009b0fd6ebfa9eda39f30f299` first activated as
`0441dfb0-e019-4e27-ad49-dd45e2c737cf`, with 17 continuity samples and zero
failures. The same runtime then activated as
`6b45e95a-aefb-4758-9c50-984032203e89` with `SESSION_DENIAL_WRITER_V1`
and `SESSION_DENIAL_CLEANUP_V1` enabled: 16 continuity samples, zero failures,
two post-command samples, and zero remaining fixture rows. Maintained activation
enforced exact-source iOS/macOS parity and CI. No native binary was distributed.

Before enabling the flags, a real bounded cleanup pass checked all 32 session
candidates, found zero invalid records, and persisted completion. Earlier helper
startup and authority-read failures remain recorded. The latter exposed a
Cloudflare runtime `1104` response from the temporary operator endpoint. A short
startup settling period and bounded read-only retries in that private transport
allowed a fresh real pass; production operation budgets and cleanup implementation
were unchanged. Unknown writes were not replayed, and no health timestamps were
fabricated. Every temporary endpoint was removed and its maintenance lease
reconciled before the next attempt.

Production acceptance passed on that active version. Ordinary logout took
863 ms (a second normal logout took 1,241 ms); the response cleared the cookie and the exact SQL row was gone. Under
forced synthetic identity-lock contention, logout returned the expected 503 after 5,751 ms;
the old cookie was rejected while its SQL row remained, and another session
remained usable. Scheduled cleanup removed the row 30,290 ms after lock release,
without a manual sweep. Protected readiness passed, the provider inventory was
unchanged, and fixture cleanup left zero rows. The intentional 503 is retained
as a forced failure, not counted as successful availability.

## Monitor installation

The independent Mac monitor is running exact source
`aa49644aebe3321747013c4c3a039904fda0bb42`. Eight consecutive post-install
probes passed across 140 seconds; the replacement gap was 20.849 seconds.
The installed bundle and running process were verified. Incident state and the
existing responder conversation were preserved; no new inference or thread was
created by installation. Production app routing was unchanged. These samples
precede activation of the faster logout path.

## Initial production watch

From 17:09:07 to 17:12:27 UTC, all 11 independent monitor probes passed.
The maximum start gap was 20,002 ms, and none exceeded the former ten-second
composite deadline. Successful logout median was 979 ms (range 797–1,392 ms),
compared with the earlier 24-hour 3,843 ms median. Revoked-cookie checks had a
231 ms median (range 188–354 ms), compared with 274 ms earlier. These windows
have different sizes and workloads; the approximately 75% logout reduction is
an initial observed improvement, not a demonstrated long-tail percentile.
All failures outside this bounded window remain in the original history.

## Validation and remaining measurement

Local main validation passed 1,386 tests with 328 environment-dependent skips;
23 monitor/report tests subsequently passed. Production integration initially
failed one stale fixture assumption about the number of stored objects. The
matching reviewed PostgreSQL/keyset/process-loss tests were carried over in
`0d7966cb83b85a8009b0fd6ebfa9eda39f30f299`; 103 focused local tests passed.
Production repository CI and macOS checks passed. The first iOS attempt never
acquired a hosted runner; GitHub reported macOS arm64 capacity constraints. Its
rerun passed all native tests and simulator evidence checks. Final monitor source
`aa49644aebe3321747013c4c3a039904fda0bb42` passed repository, secret scan, iOS
and macOS checks. Its first repository attempt hit the existing intermittent
WebKit draft-reload failure (#200); the focused local check and unchanged CI rerun
passed. No test was removed or relaxed.

Production denial-reader acceptance passed against the active baseline
`6797153537ce85e0970ce59de95add1f168e4c9a`; the six relevant reader modules
are identical to the candidate. Both API and SDK rejected a synthetic denied
cookie while its SQL row remained. Recreating that exact owned session row did
not restore access; another session remained usable. Protected readiness passed
and fixture cleanup left zero rows. Two earlier helper attempts are retained:
one rejected its own conditional-write probe because its key scope was too narrow;
another returned a storage-write error. Both were reconciled and cleaned up
before fresh attempts; unknown writes were not replayed. The latter was not
reproduced by fresh conditional probes or the successful acceptance run.

Private raw observations, one-shot mutation records, provider proofs and failed
preparation attempts are retained under `artifacts/private/logout-latency-20261112`.
A file-permission validation failure and preparation attempts during another
release stopped before activation. The inactive upload was not replayed.

A 99.99% monthly objective is not established by these bounded tests. Sustained
operation distributions, coverage and failure budgets remain measured follow-up;
physical-device logout latency is not asserted by server or simulator checks.
