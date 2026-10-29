# Bounded schema migrations

`scripts/migrate.ts` now uses a five-second connection timeout, a one-second
server lock timeout, a 15-second statement timeout and a ten-second idle-in-
transaction timeout. Each migration and its ledger insertion share a transaction
with a 30-second server transaction timeout. Connection shutdown is bounded to
five seconds. PostgreSQL 17 or newer is required for `transaction_timeout`.

The connection defaults also bound schema-ledger creation and reads. A timeout
stops the batch; the runner does not retry or proceed to later migrations. Never
increase these limits merely to make a busy release pass. Review large changes
as bounded expansions/backfills and postpone destructive contracts until older
application versions and clients no longer require them.

An error or lost connection is not proof that COMMIT failed. Reconcile the
schema definitions, privileges and migration ledger read-only before deciding
whether a new invocation is safe. Keep the existing deployment lease, source
pins and one-shot operation evidence: this runner does not itself acquire the
release lease or implement a durable migration-intent/reconciliation protocol.
The limits reduce lock exposure; they do not prove zero user-visible delay.

## Local contention verification

`scripts/migrate.test.ts` requires `MIGRATION_BOUND_TEST_DATABASE_URL` pointing
to the dedicated local `porchday_migration_bounds_test` database and rejects a
pre-existing migration ledger. CI creates that database separately and supplies
the variable. Without it, the test is explicitly skipped.

On October 29, the test ran successfully against local PostgreSQL 17. It applied
the baseline migrations, held a writer-compatible RowExclusive lock on group
invitations, and observed the migration waiting for a conflicting lock. A table
read completed in less than one second during that observed wait. The migration
exited unsuccessfully between 0.7 and five seconds, with the one-second lock
limit configured. Read-only checks verified that migration 052's functions,
trigger and ledger entry were absent and its column privilege was unchanged.
Only after proving rollback and releasing the held transaction did a separate
local invocation apply the migration and record it once.

This is a local DDL-contention and atomic-rollback test, not a lost-COMMIT-reply
test, hosted traffic test or migration-under-production-load acceptance. The
dedicated local database was removed after verification. Hosted staging evidence
and old/new browser/native continuity remain requirements in issue #3.
