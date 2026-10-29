# Staging backend release continuity, October 29, 2026

At 14:19:31 UTC the observed staging activation and synthetic-fixture cleanup
completed successfully. Candidate `d6fd3faca61d2d5c350d62f4e8ad5bcd50cc8f32`
is active as version `93259d5e-7407-484e-858b-7e72a7c85595`.
Maintained tooling was clean commit `b65371965372a8300f57b5b3c3c9d28bf57a98cd`.
Production and both public asset sets were unchanged by this operation.

## Evidence

Migration operation `3e913c57-bc69-4b96-8ea2-f9963b37f408` applied additive
migration 052 to staging with bounded lock/statement/transaction deadlines.
Read-only reconciliation confirmed 57 migrations, unchanged column fingerprint,
expected function changes and unchanged provider deployment. Production remains
at 56 migrations. Exact candidate push Verify run 40885596802 and Secret scan
40885597110 passed; tooling push Verify 40885612520, Secret scan 40885612537 and
browser check 40885612889 passed. The CI lock-contention test rejected the
blocked migration in about 1.129 seconds while a concurrent read took about
0.786 milliseconds, then verified rollback and a subsequent local application.
This local result is not a hosted load test.

Inactive upload `409473f5-1113-4045-888c-d367d1189713` was verified once.
The first activation operation `1201281f-94bd-4347-bc4b-eac347d887f9` was
rejected before acquiring the deployment lease or writing an activation journal:
its plan omitted the canonical reader-floor acknowledgment. Provider version
and deployment ID were verified unchanged, its two synthetic fixtures were
removed, and its watch was archived as operator-resolved with rejection
evidence. It was not replayed or recorded as a successful deployment.

Corrected operation `472e3694-197c-4aaf-8f21-15c6d5d60a8f` used the same verified
inactive upload, acknowledged the existing canonical reader floor, and kept the
immediately preceding version `c0b3699a-d485-4a76-921d-fe193500d810` as its actual
automatic rollback target. Isolated local canonical-copy lease validation passed
before this fresh operation created new synthetic fixtures.

The real activation ran through `executeActivationWithContinuity`. All 13
retained samples passed, including two whose requests started after command
completion; maximum sample-start gap was 2019.917 milliseconds. Retained events
include candidate-observed provider phase. An existing allowed session remained
usable and the previously revoked cookie remained rejected. The new roster
route rejected a non-owner with 403. Both synthetic accounts were logged out
and removed; read-only checks confirmed zero fixture rows. Final provider
inventory matched verified canonical state, and the shared lease was released.
The independent monitor reported healthy at 14:19:13 UTC.

## Limits and remaining acceptance

This proves the sampled backend transition, not uninterrupted availability
between samples or the monthly 99.99% objective. The backend activation did not
publish the new frontend. Hosted owner invitation/picker happy paths, an
already-open old browser, new browser behavior, native compatibility and the
forward/rollback asset release remain outstanding. Local asset overlap testing
already demonstrated why old hashed assets must be retained, but used local
unauthenticated API stubs. Production promotion remains held on issue #40
recovery requirements and verified staging acceptance.

The rejected attempt also exposed a diagnostic gap: the continuity wrapper
reported a generic command failure without retaining the original pre-lease
exception code. Isolated diagnostic execution established the reader-floor
rejection. Follow-up should retain a sanitized error code and validate canonical
compatibility before allocating hosted fixtures, without weakening lease checks.
Issues #3 and #41 remain open with needs verification.
