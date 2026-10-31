# Owned revocation across a deployment boundary

`scripts/auth-inflight-revocation.ts` supplies the request-side callbacks for
the maintained staging in-flight rollback probe. The caller supplies a dedicated
connected PostgreSQL client, a separate query connection/pool, a fresh private
evidence directory and an explicitly owned synthetic session. It must verify
the staging database, deployment lease, fixtures and current provider inventory
before invoking this helper. HTTP requests target only staging.

`start` records an exclusive intent, checks session ownership, captures the SQL
commit baseline/generation and acquires that member's advisory transaction lock
without waiting for a competing holder. It dispatches one normal
`revoke-sessions` POST. Before allowing rollback to proceed, it requires exactly
one waiter for the owned identity key whose blocking connection is this helper's
backend PID. A pending client promise alone is not accepted.

The controller invokes `finish` only after observing the exact restored
deployment. The helper checks again that the original request is unfinished and
that the same owned connection still blocks its identity waiter. It records
this observation before releasing the lock. The original response must be 200
within ten seconds, and the revoked cookie must return 401. Failed or unknown
outcomes are retained without replay. Callback success still requires an
independent post-rollback audit of the original canonical commit and receipt.

The local lock timer destroys the dedicated connection after nine seconds;
PostgreSQL transaction and idle-transaction limits are 12 seconds. SQL reads are
bounded to five seconds and honor enclosing cancellation. The controller's
existing dispatch and observation deadlines still apply to the callbacks. The
outer harness must always await `close()` in `finally`; it destroys any retained
connection, aborts outstanding observations and settles the one request. Server
limits cover process loss when local cleanup cannot run. Never hold a global or
another member's lock, extend the budgets to obtain a pass, or redispatch an
unknown request.

Evidence excludes cookies, response bodies, passwords and raw provider errors.
Only the caller may remove its exact synthetic fixture after reconciliation.
Existing evidence is never overwritten, including after a partially started
operation. Keep it for read-only investigation.

Local verification passed 21 focused cases and the full 28-test auth-journal
PostgreSQL suite. The latter exercises a real restricted-role auth request and
real lock-wait metadata, then checks its canonical marker/receipt, session
revocation and an unaffected account. That suite uses simulated journal storage
and maps the denial read to the actual auth `list-sessions` route because its
local app mounts only auth routes. It does not switch a hosted Worker or test
the hosted `/me` path. Hosted in-flight switching remains unverified.
