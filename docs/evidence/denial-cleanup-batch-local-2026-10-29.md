# Bounded denial cleanup batching: local validation

This candidate reduces database round trips for independently verified session
revocations. It does not establish production latency improvement, pilot capacity,
or the availability SLO. No hosted deployment or production writer enablement is
part of this evidence.

The candidate sweeper retains its 24-item authority-read groups, six concurrent
reads, 100-item pages, five-page drain limit and 20-second work-start budget. After
all authority reads settle, only verified denial IDs reach SQL. Groups of fewer
than four IDs retain scalar deletion. Larger groups capture current owners in a
read-only transaction, then delete exact IDs in a separate transaction for each
member under the existing identity advisory lock. The deletion rechecks ownership.
No transaction holds locks for multiple members, and no R2 request runs inside SQL.

SQL statement and lock timeouts remain five seconds; the client query deadline is
six seconds. These are per-operation limits, not a guarantee that a complete batch
finishes in 20 seconds. No new member transaction starts after the work deadline.
A failed batch, including a lost commit response after earlier member commits,
throws before the page checkpoint changes. Recovery repeats exact idempotent
cleanup; it never replays the original member operation.

Restricted-role PostgreSQL 17 tests compare the following query counts:

| Denied sessions | Members | Scalar SQL calls | Batch SQL calls |
| --- | --- | --- | --- |
| 24 | 1 | 168 | 10 |
| 24 | 24 | 168 | 148 |

These are local SQL call counts without injected network latency. The benefit
therefore depends strongly on how sessions are distributed across members.

Acceptance coverage includes pre-commit rollback, unknown commit reconciliation,
owner changes while waiting for a lock, release of the first member lock before
waiting for another, deadline interruption, exact authority filtering, page
checkpoint preservation, and an actual SQL candidate drain with 120 denied
sessions while retaining live sessions and immutable denial records.

Before hosted acceptance, require successful exact-commit CI. Staging still needs
a representative denied backlog spread across members, concurrent user journeys,
full-pass freshness and recovery measurements under the unchanged limits. Retain
the production writer/cleanup settings and existing release gates. This candidate
does not justify enabling production denial writes.

Local verification: 476 API tests passed, 28 skipped (54 files passed, one skipped)
with the CI database environment prepared in an owned disposable PostgreSQL 17
container. API typechecking, first-party formatting, secret scanning and diff
checks passed. An earlier broad run against an unmigrated database was stopped;
its missing-table failures were setup failures and are not counted as acceptance.
