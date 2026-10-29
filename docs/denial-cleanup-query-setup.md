# Reduce cleanup transaction setup requests

The confirmed-prefix staging trial still needed about four minutes to drain 400
denied sessions. Cleanup performs several small setup requests for every member
transaction, and sparse denial groups use the single-session helper. This revision
combines only static transaction setup statements into one client query. Session
and member values remain in separate parameterized queries.

Both deletion paths retain five-second statement and lock timeouts, the six-second
client query timeout, per-member advisory locks, ownership rechecks and separate
commits. The candidate listing and owner-discovery transactions remain read-only.
A setup failure or lost reply rolls back and discards the connection; it does not
permit deletion or checkpoint advancement. The confirmed-prefix budget behavior
is unchanged.

Restricted-role PostgreSQL 17 validation measured client query calls:

| Work | Previous runtime | Grouped setup |
| --- | --- | --- |
| One scalar deletion with a present row | 7 | 5 |
| 24 scalar deletions | 168 | 120 |
| Batch of 24 sessions for one member | 10 | 7 |
| Batch of 24 sessions for 24 members | 148 | 99 |
| One candidate-list page | 4 | 3 |

These are client query-call counts, not fewer server SQL statements or hosted
latency measurements. The static setup request returns multiple server results;
those results are unused. Parameterized data queries still return their ordinary
single result.

Tests check actual server timeout/read-only settings, reset on commit/rollback,
server errors inside compound setup, lost setup replies, lost commit replies,
interleaved owners, per-member lock release and bounded-prefix progress. Local
validation passed 72 focused tests and 485 API tests, with 28 API tests skipped.
Hosted Hyperdrive acceptance and a combined live-session/denied-backlog workload
remain required before making a capacity claim or enabling production writers.

Hosted activation passed 12 continuity samples with zero failures on October 29.
The [combined 10,000-live-session/400-denial trial](evidence/denial-cleanup-combined-staging-2026-10-29.md)
failed the existing full-pass freshness limit. Cleanup and recovery were verified;
production enablement remains blocked by capacity acceptance.
