# Composed inactive-upload reconciliation

`createUploadReconciler` in `scripts/release-upload-reconcile.ts` connects the
reviewed release adapters into a callback for `FileUploadLease.reconcile`. The
canonical hash of its preparation evidence must equal the upload plan's evidence
digest. The plan's operation, Worker and source must match the acquired lease.
Evidence includes the before inventory, reviewed settings/resources, database
branch and schema fingerprint, exact-source CI pins, and prepared artifact paths,
hashes and complete first-party source set. Credentials stay outside that evidence.

The callback performs the following checks while retaining the upload lease:

1. Exact-source CI and reviewed workflow pins.
2. The expected schema fingerprint on the pinned database branch.
3. Unique upload operation identity and complete candidate resource policy.
4. An inventory permitting only the reviewed inactive-version/settings change.
5. Script download, followed by fresh identity and full inventory checks.
6. Prepared executable/map hashes, exact downloaded artifacts and Git source blobs.
7. A second schema check and a final lease/canonical-state check.

Candidate resources must match completely except the opaque script `etag`, which
is excluded from policy comparison because executable and map bytes are verified
separately. Binding order does not affect comparison. Unknown resource fields,
runtime policy changes or unrelated provider changes fail closed.

Only after all checks pass does the callback persist an owner-only, fsynced proof
containing the plan hash, candidate resources, inventory and every successful
verification result. It returns that proof's SHA-256 to the upload lease. Proof
content is deterministic so interruption and repeated reconciliation reuse identical
bytes; a differing or partial existing proof is never overwritten. The containing
directory must already be private and canonical, and proof size is capped at 16 MiB.

The callback never uploads, activates, changes canonical active state or releases
the lease. Failure leaves the durable upload intent unresolved. The caller may
archive the upload lease only after successful reconciliation, then must reacquire
and freshly authorize an activation lease. This is not an atomic snapshot of the
provider/database and does not authorize future drift.

Nine integration tests use the real lease, filesystem proofs and Git source checks,
with synthetic provider, CI and database responses. They cover successful repeated
reconciliation and failures at CI, schema, resource, artifact, inventory, identity
and canonical-state gates, plus plan/evidence/database-target mismatches. The default
implementation uses the real provider reader, GitHub CI gate and read-only schema
reader; injected checks are for tests.

The complete composition has not yet been exercised against a newly hosted upload.
It verifies the runtime code source and referenced artifacts; static-asset content,
separate asset/tooling CI provenance, trusted build linkage, the normal command and
continuous authenticated staging/production rollout acceptance remain required.
