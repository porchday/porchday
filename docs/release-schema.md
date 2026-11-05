# Release schema drift gate

`scripts/release-schema.ts` captures migration names and SHA-256 fingerprints of
stored function definitions/security metadata and column metadata in the `app`
and `public` schemas. It reads no member rows. Capture uses one repeatable-read,
read-only transaction, with a five-second statement timeout, one-second lock
timeout and PostgreSQL 17 fifteen-second transaction timeout. Connections use
TLS verification and the direct database endpoint, never the transaction pooler.
The caller supplies a cancellation signal and the expected branch ID from the
reviewed environment configuration.

Pass the exact reviewed list of applied migration names. A count alone cannot
authorize a schema. Do not derive the expected list from the live database during
the same check. Capture the approved baseline under the release lease, preserve
it in private durable evidence, and call `assertReleaseSchema` on a fresh capture
before activation and rollback. Keep the baseline pinned to the release plan;
never silently replace a mismatch with the current state. An unavailable or
cancelled read fails the gate. Database errors are sanitized.

Equality detects drift in these three categories; it does not prove semantic
compatibility or the absence of concurrent schema changes after capture. Column
metadata is limited to names, type, nullability and defaults. This version does
not fingerprint constraints, indexes, triggers, policies, table grants, enum
definitions or migration file contents. Function fingerprints include definitions,
security-definer flags, configuration and ACLs, but not ownership. A compatible
schema expansion still requires an explicitly reviewed new baseline and old/new
application tests. This reader never applies migrations or authorizes contraction.

The normal release command must compose this gate with the shared release lease,
source/CI authorization, provider checks and application/asset verification.
The library alone does not enforce that workflow. On 2026-10-29 a read-only staging
capture matched all 56 migration names and both fingerprints from the earlier
verified rollback-drill baseline. No migration or activation was performed.
