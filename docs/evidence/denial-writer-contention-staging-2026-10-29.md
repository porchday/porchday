# Hosted logout contention rehearsal

Passed on October 29, 2026 at 22:59:56 UTC against staging version
`91a0bea2-1327-4806-9c46-dddc1e8133d4`, runtime
`4ef4237771cdc9ab8194a220fdb649edc3cdf38e`. No code, provider setting,
queue admission or production flag changed. Tracks #42 and #9.

Two newly allocated synthetic accounts exercised the deployed logout writer.
The operator held only the first account's identity advisory lock, with a
35-second local connection cutoff and a 45-second server idle-transaction
timeout. The lock was released normally after approximately eight seconds.
The test used at most two direct operator database connections.

| Observation | Result |
| --- | --- |
| Single logout request under contention | HTTP 503 in 5,737 ms; no retry |
| Immutable denial while identity lock held | Exact canonical record verified |
| Denied session SQL row while lock held | Still present with its original owner |
| SDK session read with denied cookie | HTTP 200, anonymous/null |
| Member profile with denied cookie | HTTP 401 |
| Separate synthetic account | HTTP 200, correct account |
| Global journal during contention | Active, unchanged generation, zero pending intents |
| Normal cleanup after lock release | Row absence observed after 50,616 ms; immutable denial retained |
| Separate account during cleanup wait | All 10 observations passed |
| Fixture teardown | Zero remaining users, sessions, credential accounts or members |
| Recovery | Four healthy journey samples; maximum journey duration 2,390 ms |
| Final recovery barrier | All three cleanup passes started after teardown; journal reached at least teardown sequence 30678; at least two healthy journeys |
| Provider reconciliation | Full before/after snapshot identical; canonical pointer unchanged; lease released |

The independent production monitor remained healthy during the operation. The
logout's deliberate 503 was a staging fixture failure, not a production outage.
The recovery time is bounded by the observation interval; it is not the exact
instant of deletion. No direct deletion of the denied row occurred before the
normal-cleanup observation. Teardown subsequently removed only the owned test
accounts, retaining immutable denial evidence.

The private one-shot runner recorded mutation intents before dispatch and
persisted observations before acceptance assertions. Its SHA-256 was
`3730f0769e0b3e65201f0c2233b8f28124970cf8e4f7304b4507d634092205ac`.
Thirty local checks covered acceptance rejection cases, production freshness and
static dispatch/cleanup/timeout invariants. Those local checks were preparation;
the hosted receipts establish the results above. The completed operation must
not be replayed.

This verifies deployed identity-lock contention, independent denial enforcement
and ordinary cleanup recovery. It does not simulate a Worker crash, R2 outage,
unknown SQL commit or concurrent password change. Hosted push enforcement,
physical-device behavior, cost acceptance and other release gates remain. The
production writer remains disabled, and this test does not establish monthly
99.99% availability.
