# Hosted web and PWA verification

This checklist separates actual hosted evidence from local tests. The smoke runner is staging-only and is not a load test, a browser driver, or an admission decision. Never substitute SQL-created verified users or verification tokens read from the database for delivered-mail verification. Synthetic accounts are disposable infrastructure fixtures, not automated social participants.

## Before the first request

Coordinate with the deployment operator. Do not run a write phase until the staging target is deployed and the operator enables its three invitations.

- Use `https://staging.porchday.com` throughout: Worker `APP_URL`, invite link generation, email callbacks and the native test configuration. Production remains closed.
- Confirm separate staging auth/social/jobs Hyperdrive bindings use their intended runtime roles and have query caching disabled. Successful public HTML does not establish database readiness.
- Initialize the independent journal against the same database generation and private R2 bucket before protected requests. Verify migrations, least-privilege grants and journal/DB readiness through the protected operations endpoint.
- Upload distinct staging auth, operations and VAPID secrets. Confirm private media/journal buckets, queue consumer/dead-letter queue, minute cleanup schedule, sender binding and sender DNS. Avoid application request logs, tracing or tails.
- Check media backup configuration and the first completed paired snapshot. Protected readiness can be degraded while the baseline is missing even when `/health` succeeds; record the outstanding issue instead of claiming full readiness.
- Configure Cloudflare Access for `/staff` and `/api/staff/*`, the origin issuer/audience and actual staff roles. A public-route denial proves neither reviewer enrollment nor two-person recovery.
- Keep `SIGNUP_ENABLED=false` except the coordinated synthetic signup window. Invitations remain email-bound and single-use when that flag is true. Reclose it immediately after the three signup requests; email verification and existing-account login continue to work.

## Staged API smoke

The runner has no Cloudflare/PlanetScale credential and cannot read a mailbox or SQL. All requests use the actual HTTPS application, normal cookies, invitation gates and authorization. It refuses production and cross-origin redirects. Output contains fixed steps, statuses and safe error codes only; it never prints responses, cookies, addresses, passwords, keys or action URLs.

Run the read-only delivery check after deployment:

```sh
node --import tsx scripts/hosted-smoke.ts public
```

It checks the staging health identity, HTML/CSP, entry assets, private-route denial, staff/operations protection, manifest, icons, worker delivery and license notices. It deliberately fails if the journal/database or required protection configuration is not ready. It does not render the page.

Create `artifacts/private/hosted-smoke` with mode `0700`. The deployment operator creates three invitations for aliases of the owner-configured operations mailbox, using suffixes such as `+porchday-<run>-a`, `-b`, and `-c`. When issuing them with `scripts/invite.ts`, explicitly set `APP_URL=https://staging.porchday.com` and the staging migration connection; the invite tool otherwise defaults to production. Do not put invitation tokens on command lines.

Place this shape in `artifacts/private/hosted-smoke/input.json`, mode `0600`, substituting the actual aliases and private invitation codes:

```json
{
  "synthetic": true,
  "origin": "https://staging.porchday.com",
  "accounts": [
    {
      "email": "owner+porchday-run-a@example.com",
      "inviteCode": "private-invitation-code-for-a"
    },
    {
      "email": "owner+porchday-run-b@example.com",
      "inviteCode": "private-invitation-code-for-b"
    },
    {
      "email": "owner+porchday-run-c@example.com",
      "inviteCode": "private-invitation-code-for-c"
    }
  ]
}
```

Then prepare local random passwords/handles and, only during the authorized signup window, create the accounts:

```sh
node --import tsx scripts/hosted-smoke.ts init
node --import tsx scripts/hosted-smoke.ts signup --run
```

`init` refuses to replace an existing run. The state file is ignored by Git and owner-readable only. It contains synthetic passwords and, after key setup, synthetic recovery material; never use it for a real member. Signup checks that it grants no authenticated member session, then pauses before social work. The unverified password-login denial is covered locally; retrying it here would intentionally send another verification message. A provider “queued” or “delivered” status is not proof of inbox receipt or working links.

Complete verification from the delivered mailbox, either through the ordinary browser link or by placing the three actual delivered links in mode-0600 `verification-links.json`:

```json
{
  "source": "delivered-mailbox",
  "links": [
    "actual delivered link A",
    "actual delivered link B",
    "actual delivered link C"
  ]
}
```

If using the file, run `node --import tsx scripts/hosted-smoke.ts verify --run` before clicking those links elsewhere. That phase tests their expected redirects and rejects replay. The alternative of clicking links manually is valid mailbox evidence, but does not run the replay assertion. Do not replace this file with URLs recovered from SQL or an encrypted outbox; that would test a different boundary and must be reported separately.

Once all accounts are verified:

```sh
node --import tsx scripts/hosted-smoke.ts social --run
```

The runner verifies the identity of every account before social writes, then checks:

- Device/recovery key setup; real OpenPGP encryption/decryption; intended-recipient reads; outsider denial and inability to decrypt; no automatic historical access for a new friend.
- Encrypted profile customization and a small real JPEG through private R2 upload/download.
- A friend's post containing a readable comment by someone outside the viewer's own friend list.
- Two reactions each on a post and comment, idempotent repeated adds, and independent removal; newest-first feed order.
- Private group invitation/acceptance, outsider denial and immediate access loss after removal.
- Paged own-post export, local decryption and text-only re-encrypted private import; duplicate-safe retry, no friend access to the import, and invalidation after source deletion.
- A rejected stale deadline acknowledgement, successful inherited comment deadline, and denial after post expiry.
- Block enforcement and rejection of old cookies after logout.

The three-account run is deliberately bounded. It does not establish the 300-connection concurrency limit, full archive/photo round-trip, iOS interoperability, actual push delivery, cleanup-independent expiry, physical object deletion or load/cost objectives. Existing focused database/crypto tests cover some of those invariants; remaining hosted/browser work is listed below. A failure leaves the private fixture state for diagnosis and cleanup; rerunning the social phase is intentionally refused because partial relationships/content would invalidate its assumptions.

After browser/native inspection, or after a failed social run, remove the fixtures through the actual journal-backed account deletion flow:

```sh
node --import tsx scripts/hosted-smoke.ts cleanup --run
```

Cleanup deletes any groups owned by these accounts first, requests account deletion, verifies session denial and records progress per account. It continues across failures but returns a failure if any account needs attention. Unverified accounts or an uncertain network outcome may need operator review; do not interpret a failed login as proof of deletion. Separately verify cleanup/outbox progress and private R2 removal, including the delayed second deletion pass. Remove the local input/link/state files after evidence and cleanup are complete. Do not upload them as artifacts.

## Real browser and PWA checks

Coordinate browser ownership with the operator. Use documented CUA controls, not a second driver attached to the user's browser. Keep screenshots free of passwords, recovery codes and verification links. Record browser/OS, release and outcome; do not capture private content from real accounts.

1. On desktop and a narrow mobile viewport, inspect the homepage and truthful nonprofit/open-source disclosures. Check navigation, visible focus, labels, error announcements and touch targets. Complete signup, login, key setup and recovery-secret acknowledgement with a synthetic account; check that Home opens by default.
2. Open three isolated synthetic sessions. Exercise connection acceptance, wall/profile themes and photos, timed posts/replies, the visible inherited-deadline warning and shorter choice, multiple reactions and private groups. Verify controls reflect denied/deleted content after navigation and refresh.
3. Export a protected multipart archive with photos, unlock it locally, inspect supported fields, preview import into a clean synthetic account and confirm re-encryption/private journal semantics. Test expired attachments and a deliberately malformed photo without exposing another member's contributions.
4. Install the PWA. Confirm start URL `/app`, icons, standalone display and login. Inspect Cache Storage: only public shell/assets; no `/api`, encrypted private responses, decrypted photos or rendered member pages. IndexedDB may contain an explicitly remembered device protected by its local nonextractable key; it must never contain the recovery secret.
5. Keep the first installed release open with an unsaved draft. Deploy a genuinely changed public shell build and check that the update notice appears, respects the draft, and activates/reloads only on consent. `vite.config.ts` already derives a deterministic cache revision from the emitted shell and assets; `public/sw.js` is the source template, not the final build. Verify old cache removal after activation.
6. Go offline after a normal load and after signout. The public shell may load; protected requests fail and no prior member content appears. Sign out, switch accounts and revoke a remembered device; check stale decrypted views and local remembered keys are cleared according to the explicit setting.
7. Opt into generic Web Push, verify actual delivery, follow its generic app link, disable it and sign out. Confirm no post text, member identifier or private photo reaches the push payload. Native APNs and universal links remain separately gated on real Apple signing.
8. Exercise stolen-account report/contact verification, resume/appeal and two distinct authorized staff decisions with synthetic evidence. Check unauthorized/direct-origin staff paths and locked/suspended data controls; do not confuse API route denial with a working Access/MFA policy.

Record actual mailbox delivery, protected monitor readiness, alert outage/recovery delivery, hosted restore timing, retained ciphertext deletion, and provider cost/retention inspection separately. These are launch gates, not results implied by a green API smoke run.
