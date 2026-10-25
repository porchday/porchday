# Isolated hosted restore drill

This procedure tests an actual PlanetScale point-in-time restore together with the production R2 media snapshot and independent privacy journal. It creates temporary, private targets. It does not change either live application's bindings or quarantine the live source. A completed local dump/restore drill or synthetic Worker probe is not evidence that this hosted procedure has passed.

The operator must coordinate the fixture and source-write window before execution. Keep admissions closed. Preserve the web/native interoperability fixture until those checks are complete; use separate, clearly synthetic test records for restore assertions. No provider action described below has been performed by this document itself.

## Owner-requested snapshot

Migration `039_manual_media_backups.sql` adds an invoker-rights owner function. Public, auth, social and jobs roles cannot execute it. The daily `day` uniqueness constraint remains; manual inventories have `day = NULL`, so they cannot overwrite the day's scheduled run. A UUID/time retry returns its existing inventory, never captures a new one. Both types expire exactly seven days after their paired timestamp.

After applying the migration and deploying the queue consumer, an authorized operator can run:

```sh
python3 scripts/with-secrets.py npx tsx scripts/start-media-backup.ts staging --run
```

The command accepts only the environment-specific migration credential and checks its PlanetScale branch suffix against `infra/resources.json`. It requires an active, zero-pending journal matching the source database. It obtains the paired UTC time in a separate SQL statement before the frozen inventory scan, persists an operator ticket under ignored `artifacts/private/restore-ops/manual-media-backups/` (directory mode 0700, file mode 0600), creates the inventory, verifies the same zero-pending source control and database sequence after capture, and sends the ordinary `media_backup` queue message. It neither uploads owner credentials to the Worker nor introduces a public backup route.

If SQL/queue confirmation is ambiguous, resume using the existing ticket's UUID rather than create another run:

```sh
python3 scripts/with-secrets.py npx tsx scripts/start-media-backup.ts staging --run --resume=RUN_UUID
```

A retry whose inventory was never committed and whose paired timestamp is now more than a minute old fails closed. A changed source checkpoint before capture confirmation also fails closed; do not reuse an unconfirmed inventory against a different source cut. Inspect the run before creating a fresh ticket. A queued response is not completion: require a complete, unexpired immutable manifest from the ordinary native-R2 copier, verify its entire chain and raw hashes, and record its exact `run.restore_at`. The copier can initialize missing R2 state from an existing generation-checked frozen SQL inventory; it cannot replace existing state or completed snapshots. Duplicate queue messages retain the normal CAS lease/cursor behavior.

## Fixture and timing sequence

1. Run `npx tsx scripts/hosted-restore-fixtures.ts prepare --run` only in the coordinated window. It reuses the protected synthetic staging account state, leaves the native interoperability fixture unchanged, and uses the actual invited-member HTTP API to create a surviving encrypted post/photo and a second post/photo to delete. Add a timed thread with a deadline comfortably beyond the snapshot and test window. Retain the private client keys locally for final decryption. Store only IDs/timing evidence in the ignored operator artifact directory.
2. Request the manual snapshot and wait for the complete manifest. Verify both photo objects are included; preserve the earlier bootstrap snapshot. Record its exact paired timestamp and current journal sequence. The database timestamp precedes inventory capture, so the later provider restore must use that exact timestamp rather than the time the copy finished.
3. Run `python3 scripts/with-secrets.py npx tsx scripts/hosted-restore-fixtures.ts after-snapshot --run --snapshot=RUN_UUID`. It verifies the complete snapshot and inclusion of both photos before using the actual member API to delete the designated post/photo and shorten the timed thread, waiting for the API's independent journal acknowledgment. Include a child comment to check inherited deletion. Do not directly modify SQL fixtures to simulate member behavior.
4. Coordinate a brief source privacy-write pause while taking the latest stable journal cut. Ordinary source reads continue. Scheduled cleanup may advance the sequence, in which case the copy refuses and the operator chooses a new target/cut. This is a finite test cut, not a claim that future source deletions are automatically mirrored to the isolated target.
5. Wait until PlanetScale's available WAL restore window includes the paired time. Its current documentation describes recovery through approximately five minutes before the present; verify actual availability and the preceding base backup. Daily snapshot retention alone does not prove that an exact timestamp is restorable. [PlanetScale PITR](https://planetscale.com/docs/postgres/backups/point-in-time-recovery)

## Isolated targets and journal cut

Use a fresh eight-hex nonce. Create a temporary `porchday-restore-NONCE` PlanetScale branch in the staging database, economical PS-5 ARM, zero replicas, PostgreSQL 17 inherited from the source, us-west, and 10 GiB fixed storage. Use `pscale branch create` with `--from main --restore-point PAIRED_TIMESTAMP --cluster-size PS_5_AWS_ARM --replicas 0 --region us-west --min-storage 10737418240 --max-storage 10737418240`. Confirm the installed CLI's argument order and provider response before running; preserve the actual requested/restored time privately. Poll readiness without blocking the operator for long intervals. Do not use the source branch's credential against the target or reset the source's role passwords. [PlanetScale create-branch API](https://planetscale.com/docs/api/reference/create_branch)

Create distinct private R2 buckets `porchday-restore-NONCE-journal` and `porchday-restore-NONCE-media`, with managed public domains disabled and no custom domains. No public app, Hyperdrive, scheduler, email job or push job should target them. The existing staging media-backup bucket is a read-only snapshot source. Record a crash-cleanup deadline and resource IDs privately; delete temporary resources at the end rather than extend backup retention.

Set `RESTORE_DRILL_JOURNAL_BUCKET` only in the private operator environment, then run:

```sh
python3 scripts/with-secrets.py npx tsx scripts/clone-journal-for-drill.ts staging --run
```

The source adapter only reads. The target uses the existing temporary authenticated native-R2 operator bridge and verified atomic conditional writes. The copier verifies every immutable batch through the production journal verifier, refuses any pending operation or database tail beyond the independent checkpoint, and checks that source generation/sequence/head/control and database sequence remain unchanged before and after copying. It publishes target control only after verifying the complete chain, preserving generation/head/sequence but forcing quarantine. It checks again after publication; any uncertainty leaves an unused quarantined target. The short-lived operator Worker and custom domain are torn down and their absence verified. No source receipt, intent, control or session is mutated.

An initialized target cannot be silently replaced. If a copy fails, leave it unused and remove it as an isolated artifact after recording the failure. A fresh successful cut is needed; do not release an uncertain target. This does not replace the source quarantine required for a real disaster restore, where all writers must be stopped and unresolved intents reconciled.

## Restore checks and release

1. Capture the provider's exact PITR result and elapsed provisioning time. Reset credentials only for the restored target's managed owner/runtime roles; retain restored object ownership and grants. Store new credentials with mode 0600, never in arguments/output. Before replay, verify that the snapshot contains the soon-to-be-deleted records and pre-restore sessions; this proves the later disappearance comes from reconciliation.
2. Point a private operator process at the isolated target DB, journal and media. Do not edit live `infra/resources.json` bindings. Optionally copy the selected snapshot's to-be-deleted media into the target before replay using the same native operator copy path, proving that replay removes physical stale bytes as well as rows. No source media object is deleted.
3. Run `restore-safety.ts replay` against the target with the cloned latest journal. Assert deleted content/children are absent, shortened expired content cannot read, all restored sessions and integration capabilities are invalidated, and relevant credential-change holds survive. Verify runtime auth/social/jobs privileges remain separated with no owner role memberships.
4. Run `restore-safety.ts restore-media` using the exact manifest timestamp. It restores only still-required bytes, checks complete inventory coverage and both database digests, and never reintroduces journal-deleted media. Test a missing required target object causes release refusal, then restore that object through the verified path.
5. Review the target sequence, run `release`, and check the target's social role: the owner can read/decrypt the surviving post/photo using locally retained keys; an unrelated member cannot. Deleted/expired targets remain absent. The target stays unbound to public app traffic even after release.
6. Record aggregate assertion results and phase durations. Delete the temporary branch and private target buckets (including any copied ciphertext), then independently verify they and the operator Worker/domain are absent. Preserve only sanitized evidence and the private operator tickets required for audit. Report temporary incurred costs separately from live recurring capacity.

The evidence should distinguish provider PITR success, journal replay, media integrity, cryptographic decryption, role/session isolation, release refusal, and cleanup. A failure at any phase is a failed hosted drill until resolved; no snapshot or source fixture should be silently rewritten to make it pass.
