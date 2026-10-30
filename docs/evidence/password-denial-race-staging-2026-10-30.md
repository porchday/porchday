# Hosted password reauthorization after session denial

Completed October 30, 2026 at 00:33:12 UTC. Tracks #42 and #1. This verifies
the denial-first ordering of an already-started password change in staging.
It does not establish hosted password-first ordering or recovery after process
loss, storage failure or database rollback.

Staging remained at `0d333719-a457-40a5-94a2-8ee4a2371ded`, runtime
`3c50e2ebe7a6dcf29177867be7dca373e110d4c0`. Operator checkout
`543f97b649a773989adff04ee79bb62be6873d46` and release tooling
`4d4ed89e7b19bda88a0e469065afebf629ac098c` each passed all six applicable CI
checks before execution. The revised private acceptance policy passed 46 checks;
the database-pooling and exact-lock observation preflights also passed.

## Race and observed results

The rehearsal allocated two fresh owned synthetic accounts. It held only one
account's identity advisory lock and dispatched one password-change request.
Before dispatching logout, it observed an ungranted waiter on that exact lock.
It then confirmed the immutable session denial and retained SQL session before
releasing the lock. This establishes the ordering without changing global
storage, cleanup or application configuration.

- The fixture lock was held for 2.748 seconds, below the 12-second local limit
  and 15-second server fallback; neither limit expired.
- Logout returned 200 in 1.702 seconds.
- The already-started password change returned 401 in 3.854 seconds after
  in-transaction reauthorization. The credential hash and unchanged-credential
  timestamp were verified against the fixture's original state.
- The denied cookie returned an anonymous SDK session and 401 from the member
  endpoint. The unrelated account remained usable.
- A login using the proposed new password was rejected. A fresh login using
  the original password succeeded and could read its own member record.
- The independent journal was active with zero pending operations.

Each mutation was dispatched once. Request outcomes and lock observations were
recorded durably; unknown outcomes were not retried.

## Inconclusive first operation

An earlier, separate operation did not observe the password request waiting.
Its fixed poll count stopped after approximately 1.887 seconds, before the
intended observation deadline. It sent no logout. The password request was
awaited before cleanup, but its HTTP outcome was not retained by that initial
harness; this operation is not password-race acceptance evidence.

Its exact fixture cleanup, recovery, unchanged provider inventory and lease
release were verified before starting a new operation with fresh identities.
The revised harness uses an elapsed-time deadline and retains each request's
outcome even when a later assertion fails. The original terminal operation and
its evidence were preserved and were not replayed.

## Cleanup and limits

The successful rehearsal removed all owned fixture rows while retaining
immutable denials. Four recovery journeys were healthy (maximum 2.127 seconds).
Journal publication reached the cleanup barrier, all three denial ranges
completed fresh passes, provider inventory and canonical deployment were
unchanged, and the deployment lease was released.

Production remained at `048cd033-4855-4100-9fc2-d1d179fe398b`; production denial
writers and cleanup remain disabled. Application security deadlines were not
changed. Both operations are terminal and must not be replayed.

Local SQL-backed tests cover both controlled password/logout orderings. This
hosted evidence covers only denial becoming authoritative before the waiting
password change reauthorizes. Native-device acceptance, the opposite hosted
ordering, interrupted privacy-operation recovery and measured monthly
availability remain open.
