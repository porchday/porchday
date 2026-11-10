# Rejoining after account deletion

Issue #213 and PR #214 fix a verified recipient being unable to receive another invitation after deleting their account. The old issued-request cooldown survived deletion even though the account and usable invitation were gone. Subsequent requests returned the normal enumeration-safe response without issuing mail.

The eligibility query now exempts issuance predating a retained verified join whose claimant and invitation have been removed. Existing accounts and live invitations still block new issuance. Sender quotas, recipient advisory locking, revoked-invitation handling and old audit rows remain intact. A replacement begins its own cooldown; an old completed join cannot exempt newer requests. No schema, authentication, encryption or native binary change was required.

## Verification

- Forty PostgreSQL invitation tests passed, including concurrent replacement requests, existing-account protection, original audit retention, and replacement cooldown after token removal. Five authentication/recovery tests and the backend typecheck passed.
- The first broader local test invocation lacked database migrations; normal migration preparation fixed the fixture setup and the tests then passed.
- Exact-source release CI passed for both preserved runtimes. Production Verify run: 42764360329; secret scan: 42764360426; browser: 42764360536; iOS: 42764360326; macOS: 42764360371. The production native parity gate independently verified successful required steps on the exact revision. Physical-device acceptance was not substituted for these checks or claimed.
- Hosted staging and production checks used synthetic accounts to verify replacement issuance, duplicate suppression, retained audit records and renewed cooldown. The verifier cleaned up its fixtures.
- The reported recipient used the operator-authorized one-time replacement and completed creation of a new active, email-verified account. This establishes rejoin completion, not restoration of the deleted account or encrypted history. The earlier encryption-unlock failure remains a separate unconfirmed report. No private recipient information or invitation credentials are included here.

## Deployment

The implementation merged in PR #214. An overlapping causal-observability release changed the baseline during preparation, before this task uploaded a candidate. Final candidates were rebuilt on top of that release, preserving its runtime changes.

- Staging backend revision: `73ea06087106ab39f924f287a0cfc7bda8f91d69`; Worker `120f6418-63e6-4e3a-8844-f47bfdd80fe5`.
- Production backend revision: `2138cb05c7f8bad67e260e7431e538e943286250`; Worker `40aa0378-711c-4fe9-9a4b-36e93ad3f801`.
- Staging activation completed at 06:23:30 UTC on November 10 with 13 continuity samples and no failures. Production activation completed at 06:26:25 UTC with 14 samples and no failures.
- Existing frontend assets and native shells remain in place; the corrected invitation behavior is supplied by the shared server.

Earlier source candidates encountered the already-known public-commit-ID secret-scan false positive; the existing exact-value correction was applied. The unrelated main-source composer browser assertion failed once and passed on rerun; the original failure is retained and recorded on #207. Staging activation preparation also rejected a local evidence file with incorrect permissions; permissions were corrected and a fresh review passed before activation. A private hosted verifier initially referenced an old source manifest and stopped before creating fixtures; its source reference was corrected before the successful checks. None of these failed preparation attempts is represented as successful deployment evidence.

Private evidence is retained under `artifacts/private/rejoin-v4-release-20261109`; earlier failed preparation archives remain intact. Post-activation monitoring passed with eight samples over 140 seconds and zero failures, covering login, logout, revoked-session denial, feed/profile access, readiness and monitor freshness. A fresh provider inventory at 06:29:14 UTC matched the canonical deployment, confirmed both candidate revisions, retained the existing frontend version, and found no active deployment lease.
