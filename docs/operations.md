# Porchday operations

## Admission and launch gates

Registration requires an operator-issued, email-bound, expiring invitation, adult attestation, accepted community rules, and verified email. `SIGNUP_ENABLED` is a deliberate deployment gate. Do not issue real-member invitations before the encryption review, support staffing, nonprofit/legal disclosures and backup/restore gates in the design are resolved. Synthetic test accounts are operational test identities, not autonomous social participants.

The source repository stays private. Apache-2.0 is the code license; don't claim that source is publicly downloadable until the owner publishes it.

## Secrets and roles

Deployment credentials stay outside Git at `~/.config/inner-circle/secrets.env` (0600). Use `python3 scripts/with-secrets.py COMMAND` only for trusted deployment commands. Never run an arbitrary downloaded script with that environment. Database migration access is distinct from runtime auth/social/jobs roles. Runtime roles are not owners or BYPASSRLS roles. Hyperdrive query caching must be disabled for all three bindings.

A normal login password or a support-led password reset cannot decrypt old private content. Members need a trusted device or their content recovery secret. Operators have no content master key.

## Environments

Staging and production have distinct Cloudflare R2 buckets and queues listed in `infra/resources.json`. Their databases, runtime roles, auth secrets and Hyperdrive connections must also be separate. R2 managed public domains are explicitly disabled. Preview deployments may not use production data.

## Database migrations

Run `python3 scripts/with-secrets.py node scripts/migrate.ts` with `DATABASE_MIGRATION_URL` set. The script records applied migration names and runs each migration transactionally. Review migrations before deployment. Do not rewrite migrations already applied in an environment; add a new migration. The current local development database was bootstrapped manually while the schema was being developed; rebuild a disposable verification database through this script before release to prove the clean-install path.

## Local development

Start an isolated PostgreSQL 17 Docker container on port 54329 with database `porchday`, owner `postgres`, and local-only password `porchday-local`. Apply migrations with `PG_LOCAL=true` and the local migration URL. `npm run dev:api` starts the API on127.0.0.1:8787 with distinct runtime roles; `npm run dev` starts Vite on127.0.0.1:5173 and proxies /api. These development credentials are synthetic and must never be deployed.

Development email is captured privately in ignored `artifacts/private/dev` files; real email is sent through Cloudflare only in deployed environments. The local backend stores encrypted photo bytes in the same ignored directory. Do not use production member data locally.

Run crypto tests plus real database tests. `TEST_DATABASE_URL` supplies the auth test database; `SOCIAL_TEST_DATABASE_URL` and `SOCIAL_HTTP_DATABASE_URL` must point to separate disposable databases whose names contain `test`. Social test suites reset only their app schema. CI creates these separate databases explicitly.

## Invitations

`python3 scripts/with-secrets.py node scripts/invite.ts EMAIL` creates a one-use invitation and writes its link into a 0600 file under the private configuration directory, never stdout. Invitation codes are hashed in PostgreSQL and expire after seven days. Never distribute real invitations before the admission gates are satisfied.

## Deletion and expiry

Reads deny expired data immediately, even when jobs are offline. Cron enqueues expiry work. The queue consumer deletes expired metadata and retries ciphertext deletion through a durable PostgreSQL outbox. Every queue run is idempotent; completed R2 deletions can be retried safely. Identity deletion has a separate outbox so a transient auth-database failure cannot leave a deleted member usable.

During restoration, apply deletion-ledger decisions and expiration before resuming member traffic. A completed database restore alone is not a successful media restore. Test the documented 24-hour RPO/8-hour RTO targets before making availability promises. Full staging restore drill remains outstanding.

## Email and monitoring

Cloudflare Email Sending is enabled for porchday.com with SPF, DKIM and DMARC. Email body previews were disabled through the API to avoid retaining password-reset links in activity previews. Account emails omit private social content. The initial provider test was queued successfully; mailbox delivery still needs confirmation.

Verification, reset, account-change and recovery messages enter a durable encrypted outbox in the same transaction as their associated change. Provider delivery starts after commit; failed attempts retry with bounded leases/backoff and a 30-minute queue lifetime. Delivery is at least once: a crash after provider acceptance but before acknowledgement can duplicate an email, while its action link remains single-use. Member deletion removes queued member mail. Recovery-case mail works without assuming account ownership and can notify a contact during a security hold. Superseded recovery contact/restore links are removed from the pending queue. Case deletion/retention cleanup removes its pending mail. This is server-side encryption of operational email, separate from client-only content encryption.

Application telemetry is restricted to fixed event/code/environment labels, normalized routes, numeric status/duration/count fields. The application never intentionally logs raw paths, bodies, auth cookies, tokens, member IDs or SQL details. Telemetry exceptions cannot block account or cleanup operations. Staging/production configuration disables application Workers Logs, tracing and Logpush: disabling invocation logs alone does not prove that provider-enriched console/error records omit sensitive request metadata. Cloudflare aggregate metrics and the separate health monitor remain available. Do not enable application logs, tail consumers, real-time tails or issue collection for real-member traffic until the exact output has been verified with synthetic token URLs and a reviewed redaction/retention design. This does not claim to disable Cloudflare's own security/edge records. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) documents invocation metadata and the separate console/error records; [Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/) describes aggregate monitoring. Dashboard alerts, sender delivery/bounce verification, and costs need deployed verification; alert setup is not yet complete.

`/health` proves only that the Worker can answer. `/api/operations/health` requires a separate environment-specific `OPERATIONS_HEALTH_TOKEN`, then checks the independent restore checkpoint and database. It returns only aggregate job/email counts and fixed issue codes. It reports a missing/older-than-three-minute cleanup heartbeat, media deletion older than ten minutes, identity deletion older than five minutes, and queued email older than five minutes or exhausted delivery attempts. Only the jobs database role can read these aggregates or record a successful cleanup heartbeat. This token grants no member, staff or content access. Configure the independent monitor and verify alert delivery before admitting members.

Protected staging/production readiness also requires configured encrypted media backups and at least one completed snapshot. It flags a paired database restore point older than 26 hours, a retained unfinished copy older than two hours, and unfinished runs that have failed copy attempts. These are monitoring thresholds, not proof of the 24-hour RPO target. Readiness stays degraded during initial provisioning until the first complete baseline; `/health` remains available for basic deployment smoke checks. A recent media snapshot does not by itself prove provider database PITR availability or a successful hosted restore.

## Incident handling

For suspected takeover, an unverified report never freezes or transfers an account. Verify the claimant's safe contact, then have authorized staff review corroborating evidence. A confirmed hold must revoke all login sessions and integration grants, block export/deletion/credential changes, preserve recovery and appeals, and keep ordinary content timers expiring. Recovery of account ownership cannot recover missing encryption keys. Two distinct authorized reviewers are required where trusted methods are lost.

Staff workflow code is implemented and covered by local tests; real reviewer provisioning and Cloudflare Access policy configuration remain outstanding. Current token requests for Access organizations/apps/identity providers return403; the owner has been asked for the account-scoped Access administration permissions. Do not manually change ownership through the database as a substitute for the reviewed workflow.

## Account security and staff access

Configure `STAFF_ACCESS_ISSUER` to the exact HTTPS Cloudflare Access team origin and `STAFF_ACCESS_AUDIENCE` to the staff application's audience. The origin checks the assertion even on alternate origins. Access alone grants no staff permissions: an operator must provision the exact signed subject/email in `public.staff_users` with explicit `recovery` and/or `moderation` roles. Require strong MFA in the Access policy; deployment and verification of that policy are launch prerequisites. An empty configuration fails closed. Do not create a development bypass in production.

The recovery console is `/staff`; the API is `/api/staff/recovery`. Public reports and verified safe-contact sessions are deliberately separate from ordinary member sessions. Reviewers must document corroborating established-method/security-history evidence; a supplied email, public facts or friend endorsements are insufficient. Hold and ownership restoration are serialized with auth transactions. Two different currently authorized reviewers must approve restoration. Completion revokes all old device keys and login/MFA credentials; old encrypted content still requires the member's encryption recovery secret. A denied claimant may appeal; denial does not automatically release a corroborated hold.

Case channels expire after24hours. `/api/account-recovery/resume` sends a fresh one-use contact link only to the case's verified safe email. It does not create a login session. Recovery evidence and historical login addresses expire after90days; cleanup runs with the job consumer. Define staffing, escalation and contact details before admitting real members.

Recovery preserves the member's moderation state from before the security hold. A restricted or suspended member remains restricted or suspended after ownership is restored; only a separate authorized moderation review can lift that restriction. Repeated holds cannot overwrite the saved state. Legacy holds without a trustworthy prior state return to suspended status, and recovery cannot resurrect deleting/deleted accounts. Staff queues support state filters and stable cursor pagination, including cases with equal creation timestamps.

Ordinary suspended/restricted members retain their own data export/deletion and appeals. Suspected-takeover holds block both export and deletion. Suspended clients unlock their own encrypted backups locally for export without adding a device or opening social access.

Authenticator MFA uses the maintained BetterAuth TOTP/backup-code implementation. New login passwords are checked against the Have I Been Pwned password corpus using its padded hash-prefix API; plaintext passwords and full hashes are not transmitted. A provider error fails the password change safely. This adds an external availability dependency. Password reset/change and email change revoke old sessions; changing a verified email requires approval at the old address and verification of the new one.

## Configuration and verification

`apps/api/wrangler.local.jsonc` contains synthetic local bindings only and must never be used to deploy. `scripts/configure-worker.py staging|production` refuses to produce deployment configuration until real Hyperdrive IDs exist in `infra/resources.json`. Disable Hyperdrive query caching for identity, social and jobs bindings. Production registration stays closed (`SIGNUP_ENABLED=false`) until the admission gates pass.

For local workerd verification, build the web workspace, create a local-only `apps/api/.dev.vars` containing `BETTER_AUTH_SECRET`, and run `node --import tsx scripts/initialize-local-journal.ts` after applying migrations. This uses the current Miniflare `resourcePersistencePath` to share the actual Wrangler storage directory; obsolete `r2Persist` would silently create an ephemeral store and does not count as initialization. Start `npx wrangler dev --config apps/api/wrangler.local.jsonc --local --port 8788`. Run `TEST_DATABASE_URL=postgres://postgres:porchday-local@localhost:54329/porchday node --import tsx apps/api/scripts/smoke-workerd.ts` to verify real Workers password sign-in, authorization, cookie revocation and public security headers using a temporary synthetic account. The script refuses remote targets and removes its fixture. Keep local email/debug output in ignored private artifacts; never tail raw production auth URLs. Local synthetic debugging retains application console events with invocation logging/tracing disabled; generated staging/production configurations additionally disable application log persistence and Logpush.

The native workflow runs on relevant pushes and can be manually dispatched; each job is capped at35minutes to bound setup usage. It builds/tests with the installed simulator SDK, launches the app in a synthetic UI-test mode and stores the result bundle/screenshot for7days. Inspect the result rather than treating workflow creation as build success. The hosted simulator is sufficient for unsigned simulator development; APNs/device distribution still require separate Apple signing setup.

`node scripts/prepare-environment-secrets.mjs` creates distinct auth, operations-health and VAPID keys for staging and production in the existing private secrets file, preserving existing keys and permissions. It refuses a partial VAPID pair instead of silently rotating keys. After configuring/deploying the target Worker, upload with `python3 scripts/with-secrets.py python3 scripts/upload-worker-secrets.py staging` (or `production`). The JSON payload goes through stdin; values never enter command arguments or tool output. `VAPID_SUBJECT` points to the public contact page; assign a monitored operator contact before admitting members.

Deployment configs use `staging.porchday.com` and `porchday.com`, with workers.dev and preview URLs disabled. Native universal-link association is served only when a valid real Apple team/bundle pair is configured; there is no placeholder association document. Signing, physical-device APNs delivery and association verification remain separate from successful unsigned simulator builds.
