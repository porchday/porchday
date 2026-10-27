# Incident response

This runbook implements the selective service controls required by the design. It is an operator procedure, not proof of staffed incident response. Assign a primary operator, a backup with separately recoverable provider access, and a verified member communication channel before admitting real members. Record decisions and timestamps privately; never copy tokens, private keys, member content or recovery evidence into public issues or status updates.

## Pause only the affected operations

Each environment has three independent controls. Set the corresponding **JSON boolean** in its object in `infra/resources.json`; the deployment renderer preserves it on subsequent deployments. Absent flags default to false. Strings such as `"false"` are rejected by the renderer.

| Resource setting | Worker variable | Operations paused |
| --- | --- | --- |
| `media_uploads_paused` | `MEDIA_UPLOADS_PAUSED` | Photo reservation and ciphertext upload. Existing photo reads, deletion and cleanup continue. |
| `content_writes_paused` | `CONTENT_WRITES_PAUSED` | New/edited posts, comments, reshares, reaction additions, profile/group creation or editing, photo attachment and imports. |
| `social_invitations_paused` | `SOCIAL_INVITATIONS_PAUSED` | Sending or accepting friend and group invitations. Declining/cancelling requests, leaving groups and removing relationships continue. |

These controls are checked after member authentication and before the mutation journal or social handlers. A paused operation receives HTTP503 with a fixed explanatory message, `Retry-After: 60` and `Cache-Control: private, no-store`. Web and iOS clients display the server's message. They must retain the member's draft and require an intentional retry; do not automatically replay non-idempotent creates.

Authorized reads, export, deletion, report/appeal submission, account recovery, block/mute, key/device management and group ownership transfer remain subject to their ordinary authorization and security-hold rules. The controls do not grant access, bypass expiry or release restore quarantine. To stop both uploads and publication, enable both related controls. An upload pause alone does not stop attaching a previously uploaded photo. The integration resource API is read-only and continues to enforce its own scopes, revocation and deadlines.

Pilot admission is a separate control: `SIGNUP_ENABLED=false` closes invited signup. Keep it false during an admission incident, stop issuing invitations with the operator CLI, and revoke outstanding invitations if appropriate. The social invitation flag does not control pilot signup or server-side invitation issuance.

Deployment procedure:

1. Identify the incident, affected environment and exact currently deployed release. Work from that reviewed release; do not deploy unrelated unverified changes as an emergency control update.
2. Set the needed booleans under `environments.production` (or `staging`) in `infra/resources.json`. Keep a restricted incident record of the previous values. If admission should be closed, ensure the generated configuration also has `SIGNUP_ENABLED=false`.
3. Render and deploy the same source with the changed variables:

   ```sh
   python3 scripts/configure-worker.py production
   python3 scripts/with-secrets.py npx wrangler deploy --config apps/api/wrangler.production.jsonc
   ```

4. Confirm the provider's active deployment/version and variables, then use a synthetic account to verify the intended503 responses and ordinary authorized reads. Verify anonymous access is still denied and deletion/report/recovery actions still work. Check both the primary origin and any other configured entry points.
5. Requests already in flight or served by an old deployment can finish. Wait at least the two-minute application upload deadline after rollout, then recheck active versions, pending uploads, deletion backlog and cleanup heartbeat. A pause is not a transaction barrier or proof that a compromised writer has stopped.
6. Keep cleanup, email retries and backups running when safe. Verify expiry reads still deny immediately. Use the separate status service and a previously verified alternate communication channel if the provider itself is unavailable.
7. After the cause is corrected, verify staging and restore/integrity checks as relevant. Explicitly set the chosen booleans back to false, redeploy and verify a synthetic successful write. Record the end time, remaining impact and follow-up. Do not accidentally lift a pause through a rollback or a stale `infra/resources.json`.

The API regression suite exercises every affected route through the actual application middleware and verifies that the mutation journal is not reached. Separate tests preserve safe action handlers and test renderer persistence. A live deployment/rollout exercise remains required before pilot admission. The generic health endpoint alone does not verify these controls; deliberately paused writes will also appear as503 outcomes in aggregate monitoring.

## Builder chat

Builder chat lets allowlisted members message the Codex session that builds Porchday ([design](../design/builder-chat.md), [bridge install guide](../apps/builder-bridge/README.md)). It has its own controls:

| Control | How | Effect |
| --- | --- | --- |
| Pause | Set `builder_chat_paused` to `true` under the environment in `infra/resources.json`, then render and deploy as above. The setting defaults to `true`; only an explicit `false` opens builder chat. | Members see "Builder chat is paused" and cannot send. The bridge starts no new turn. A turn already running finishes, so the builder checkout is never left half edited. |
| Stop the bridge now | On the Mac mini: `launchctl bootout gui/$(id -u)/com.porchday.builder-bridge` | No turn runs until the bridge is started again. Members see "Codex is offline". |
| Remove a member | `node scripts/builder-chat-access.ts remove <handle>` with the environment's `DATABASE_MIGRATION_URL` | Access ends on the member's next request, and their queued message is cancelled. |
| Revoke the bridge | `npx wrangler secret delete BUILDER_BRIDGE_TOKEN --config apps/api/wrangler.production.jsonc` through `with-secrets.py` | The bridge endpoints return 404 and the bridge cannot claim messages. |

### Rolling back a builder chat change

Codex deploys every hour, so a bad change from builder chat is undone rather than reviewed in advance. Each builder chat commit ends with `Builder-Chat-Message: <message ID>`, and the staff view and bridge log list each message's commits.

1. If the live site is broken, return the Worker to the previous version first. `npx wrangler deployments list --config apps/api/wrangler.production.jsonc` (through `with-secrets.py`) shows recent versions. Run `npx wrangler rollback <version ID> --config apps/api/wrangler.production.jsonc` to return to the last good one within seconds.
2. Pause builder chat if the same request could be repeated.
3. In a clean, up-to-date checkout, run `node scripts/builder-chat-rollback.ts <message ID> --dry-run` to list the commits, then run it without `--dry-run` to revert them newest first. Add `--commit <hash>` for a commit that lacks the trailer. Run the tests, then push, or pass `--push`. The next hourly deploy ships the revert, so the broken change doesn't come back after the Worker rollback.
4. Or ask Codex in builder chat, or through the request file, to undo the change for that message ID. `AGENTS.md` tells Codex to use the same command.

A Worker rollback doesn't undo a database migration. `AGENTS.md` therefore forbids dropping or renaming columns or tables in a builder chat turn, so the previous Worker version keeps working with the current schema.

## Compromised credentials or signing keys

Determine which capability is exposed before choosing containment. A deployment credential or malicious client release can compromise delivered encryption code; content encryption does not protect a member from a malicious client update. Selective posting pauses alone are insufficient for an authentication, authorization, code-integrity or storage-integrity compromise. Restrict affected traffic at the provider, use [restore quarantine](restore-safety.md) when data integrity is uncertain, and retain recovery/status paths only when they can be served safely.

- **Cloudflare/GitHub/PlanetScale credentials:** revoke the exposed credential at its issuer using an independent trusted account; remove unauthorized sessions, deployments, collaborators and integrations. Replace only necessary scopes through the private secrets workflow. Inspect provider audit metadata and compare active code, DNS, bindings and access policies with the known-good record. If R2 or database credentials were exposed, assess data/metadata access and modification separately; replaying a backup does not undo disclosure. Do not publish a replacement token in an issue or shell history.
- **`BETTER_AUTH_SECRET`:** this supports authentication and also derives operational email-outbox encryption keys; authentication-library encrypted records may depend on it. This is not a routine blind string replacement. Contain affected authentication first, revoke sessions/one-use credentials and integration grants, and prepare a reviewed, tested rotation/migration or invalidation procedure for encrypted auth records and queued email. Expired links must not be reissued. If the old key is untrusted, fail closed and use the verified recovery process rather than bypassing MFA. Automatic key-ring rotation is not implemented; rehearse the procedure with synthetic accounts before the pilot.
- **Operations/monitor credentials:** rotate both ends of the environment-specific health capability or the dedicated analytics read token, verify the old token fails and exercise a fresh alert. Never replace a read token with the broad deployment token. These monitor capabilities should not read member data.
- **Push signing keys:** revoke/replace the affected VAPID or APNs credential using the provider workflow. Check client re-subscription requirements and test with synthetic devices. This does not rotate member content keys.
- **A member's content key:** use the reviewed device revocation/ownership-recovery flow. Server operators cannot manufacture an encryption recovery secret or retroactively erase plaintext already downloaded by a recipient. Explain any loss of historical decryption honestly.

Keep key material outside incident notes and public logs. Determine the minimum member notification and response obligations with the responsible operator/adviser; do not invent a legal conclusion from a successful credential rotation.

## Storage or database failure

Pause uploads for object-storage failures and content writes if metadata/ciphertext consistency is uncertain. Never acknowledge an upload merely because a reservation exists. Monitor retry/outbox age and retain failed cleanup work. If the database is unavailable, normal authorization cannot be established: do not serve cached private content as an improvised fallback. If the independent journal is unavailable or divergent, retain its fail-closed behavior. For restoration, follow [restore safety](restore-safety.md) and [paired media backups](media-backups.md), replay deletions/expiry/credential holds, verify surviving live media, and release quarantine only after the documented checks. The separate monitor cannot prove restored data correctness.

## Lost administrator access

Use the pre-established backup operator and provider account recovery. Do not disable staff assertion verification, grant recovery roles to an unverified new identity, edit ownership directly in SQL, or publish a temporary unauthenticated admin route. Recover provider access, remove unauthorized changes, verify named staff subjects/roles and strong MFA, then test staff access with a synthetic case. If no independently authenticated operator remains, keep the affected service closed until provider recovery succeeds. Establish and test backup access before admitting members.

## Abuse surge and moderation mistakes

For an invitation or upload surge, enable the matching control and close pilot admission when necessary. Keep reports, blocking, deletion, appeals and ordinary expiry available. Use existing per-member limits and evidence-based moderation; never loosen authorization to inspect private encrypted content. A report may disclose only what its author intentionally supplies. Do not treat a human-only policy as proof every member is human.

For a mistaken restriction, use an authorized moderation review and preserve the appeal/audit trail. Correct the minimum affected action; do not bulk-reset member status or undo a separately corroborated takeover hold. Recovery preserves prior moderation restrictions, and reversal cannot restore already deleted/expired content. Communicate the correction through the established member channel without disclosing another member's evidence. Assign an independent reviewer for complaints about an operator; source availability does not itself provide a staffed support operation.

After each significant incident, record the cause, impact, response timeline, recovery evidence and concrete prevention work in a restricted review. Publish only a suitable aggregate account through the verified status/contact channel. Test selective pauses, compromised-key response, backup admin access and a paired restore with synthetic data before the pilot and after changes that affect these procedures.
