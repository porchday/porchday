# Hosted stolen-account recovery verification

Two-person login restoration and encrypted-history recovery acceptance are confirmed for synthetic account B on `https://staging.porchday.com`, completed at **2026-10-25 23:35:07.641 UTC**. The human's post-restoration session was preserved; the operator session and disposable canary were cleaned up. This record uses the fresh contact-verified case from attempt `d9c834ae`. Staff decisions were made personally by the two authorized human reviewers; the operator did not impersonate them or bypass their reviews. This is one bounded synthetic acceptance, not evidence of staffed production recovery or an independent security review.

## Pre-hold baseline

Attempt `4a2c7e10` passed at **2026-10-25 21:16:40.187 UTC**. Read-only database checks confirmed the exact case was retained, contact-verified and `submitted`, with zero reviews, and B was active. The database connection enforced read-only transactions and selected no authentication/recovery tokens or secret hashes. A normal email/password sign-in confirmed the expected verified member through the deployed API.

B has no personalized profile envelope. The baseline preserves that null profile rather than creating one or claiming profile decryption. The single existing active encryption device and the encrypted recovery backup were captured as private metadata/hashes; its existing encrypted private key unlocked successfully with the saved recovery secret. No device enrollment, profile edit, password change or MFA change occurred. The private fixture state remained unchanged.

The bounded selection found no suitable existing B-authored private text post. Under explicit authorization, the runner persisted an immutable publication intent and client-generated identity, then made exactly one normal POST for an encrypted `only_me` text canary. Publication was acknowledged, and a separate API read and local signature/decryption check matched the expected payload hash. No photos, comments, reactions or other members were involved. The canary expires at **2026-10-26 21:16:38.092 UTC**. Its original ciphertext, author public key and decrypted-payload hash are saved privately for comparison after recovery.

All evidence files are mode `0600` beneath the protected, ignored `artifacts/private/hosted-smoke/` directory, using the prefix `recovery-prehold-4a2c7e10`. The `.session.json` file contains the captured session capability and must never be published. The `.intent.json`, `.canary-intent.json`, `.old-ciphertext.json`, `.baseline.json` and `.result.json` preserve the exact boundaries and expected evidence. No passwords, cookies, private keys, email addresses, subject/member identifiers or decrypted content appear in this document.

## Baseline session and canary obligations

**At the pre-hold checkpoint, one new session remained intentionally live** so the human-applied hold could demonstrate its revocation. Four pre-existing B session rows were also observed; the baseline did not revoke or attribute them. The later hold check fulfills the saved-session revocation obligation, and the completed continuation below fulfills canary and operator-session cleanup.

The coordinating operator and the service task own these cleanup obligations:

- After the authorized human hold, verify that the captured old cookie no longer grants access. Do not create a replacement login merely to prepare that check.
- After the separate two-person approval and claimant restoration, verify old-access denial and recovery of the saved ciphertext with the original encryption recovery material. The later attempts below establish those checks with their separate evidence sources.
- Delete the newly created canary through the normal authorized API after verification. This was completed and independently checked through API denial and the database tombstone; its 24-hour deadline was not used as a substitute for cleanup.
- If the test is canceled before the hold, normally sign out the deliberately retained session and verify denial. Never silently abandon its private capability or report blanket cleanup without evidence.

At this checkpoint the operator had separately verified the two staging recovery-role grants at **21:14:58.418 UTC**. Actual human queue access, the hold, distinct approvals, restoration-email use and completed recovery remain pending. No additional hosted request was made after the successful baseline while awaiting the human hold.

## Preserved initial guard failure

Attempt `2fbb68d9` stopped at **21:13:45.847 UTC** because the harness incorrectly required an encrypted profile for B. The actual null profile is a valid fixture state, not an application defect. This attempt made no profile/content change or recovery decision. Its new session was normally signed out, and the saved cookie was independently rejected with HTTP 401. The failed receipt remains unchanged. The later attempt accepts the known null profile explicitly and supplies separate, authorized old-ciphertext evidence instead of manufacturing a profile.

## Human holds and saved-session denial

Both nominated people confirmed that they could view the recovery queue after their roles were granted. Independent exact-case audit inspection corroborated their post-grant queue access. The owner recorded a hold at **22:15:19.370 UTC**, followed by the other authorized reviewer at **22:16:20.704 UTC**. There was one corresponding hold audit per reviewer and no restoration approval or unknown actor.

The initial operator check expected only the owner's hold and therefore preserved a failed expectation receipt. A bounded follow-up at **22:18:06.321 UTC** established the two authorized holds and the assignment to the second reviewer. This was an extra human Hold action, not an application failure; no decision or original receipt was rewritten. Further human instructions must explicitly select **Approve restoration (two reviewers required)** rather than repeat Hold.

At **22:18:05.435 UTC**, the captured pre-hold cookie returned **HTTP 401** on both `/api/v1/me` and the exact saved canary's read endpoint. A read-only transaction independently verified:

- B was on hold, with the previous `active` status preserved, and the exact contact-verified case was on hold.
- **Zero B session rows remained**, including the deliberately retained test session and the four rows observed before it.
- The full profile hash and null profile envelope were unchanged.
- The device roster hash and encrypted recovery-backup hash were unchanged; the existing device was still recorded as active at this hold stage.
- The canary remained unexpired with identical ciphertext and its original expiration deadline.

These checks used exactly two GET requests with the saved cookie and read-only metadata inspection. They created no login, hold, approval, restoration, email or content mutation, and made no redundant sign-out call. Fixed results are preserved privately as `recovery-hold-4a2c7e10.intent.json` and `.result.json`; no authentication/recovery token hashes were queried.

The saved-session cleanup obligation is now fulfilled by verified revocation. At this hold checkpoint, the two distinct human restoration approvals, claimant use of the resulting email, restored-account/key-history checks and normal canary deletion were still outstanding. A hold intentionally stops access without deleting encrypted history; this checkpoint is not a completed account recovery.

## Two-person approval and restoration-email checkpoint

The other authorized reviewer approved restoration at **22:28:10.566 UTC**, followed by the owner at **22:29:02.224 UTC**. Both people confirmed their actions. An earlier read-only observation at **22:28:48 UTC** correctly showed only one approval and no restoration-link expiry; it predates the second approval and is retained as intermediate evidence.

The coordinating operator's read-only inspection at **22:29:34.280 UTC** verified both eligible approvals on the exact case. The case remained on hold, with one `case_restore` email-outbox row, one provider-accepted delivery and zero failed deliveries. The restoration link expires at **2026-10-25 22:59:02.224 UTC**. Provider acceptance is not proof of inbox receipt or claimant use of the link.

At this approval checkpoint, the human claimant was asked to use the delivered restoration form with the separately prepared private password, then stop at **Your login access is restored** before signing in or unlocking encryption keys. The post-restoration harness was prepared and independently reviewed but had not run. No additional hosted requests were made to create that documentation checkpoint.

## Claimant restoration and bounded verification stop

An ambiguous human report prompted metadata inspection before any login attempt. At **23:07:08.514 UTC**, the case and member were still on hold, the first link had expired, and no post-restoration runner artifacts existed. A later human review reissued the link at **23:10:46.223 UTC**, with expiry **23:40:46.223 UTC**. Read-only inspection confirmed that the matching replacement email was provider-accepted at **23:11:37.583 UTC**, on its first delivery attempt. The human subsequently located the message in the verified contact's inbox and reported successful restoration.

After explicit authorization, the operator executed attempt **`a63df2b9` exactly once**. Before either sign-in request, read-only guards confirmed the exact case was restored, B was active, the previous hold status was cleared, MFA was disabled and no MFA records remained, every original encryption device was revoked and there were zero account sessions. The captured pre-hold cookie was rejected with **HTTP 401** on both the current-member and canary-read routes. The old password was also rejected with **HTTP 401**.

The planned new password then returned **HTTP 401**, with no session cookie. The runner stopped at `new-login` at **23:20:16.297 UTC**. Both sign-in responses were received; neither outcome was uncertain, and neither created a known session. A final read-only count confirmed **zero B sessions**. No device challenge or enrollment, encrypted-backup change, private fixture-state write or canary deletion occurred. The failed result and immutable intents remain private under `recovery-after-restore-a63df2b9`; the runner was not retried.

A bounded read-only audit at **23:21:31.508 UTC** confirmed that restoration committed at **23:17:02.102 UTC**. Equality-only checks established that the restored account and verified contact addresses both matched the B login address, and that the baseline, execution intent and password-file provenance all referred to B. The runner's removal of one terminal newline produced the same password bytes as the claimant's instructed `tr -d '\n'` clipboard command; no embedded line endings remained. The saved original device state was unchanged. No credential values, credential hashes, reset tokens or email bodies were queried or exposed. This audit found no crossed fixture, address or newline-handling mismatch; it does not establish which password the claimant actually submitted.

At this stop, clarification of the submitted credential and encrypted-history recovery remained pending. The saved-session revocation and this attempt's zero-session cleanup were verified; completed encrypted-history recovery was not inferred from successful claimant restoration alone.

## Credential reconciliation and completed encrypted-history recovery

The claimant supplied the actual submitted password through a private local file. The file was checked as a regular file owned by the user and restricted to mode `0600`. Read-only inspection found exactly one credential account with the expected account/user relationship and an update timestamp matching restoration. The installed BetterAuth verifier, run locally against that stored credential, rejected the originally prepared password and accepted the supplied password. The two values differed. No password, credential hash or mail token was printed, and this reconciliation did not change the account password or invoke another network sign-in. The original prepared file and failed receipt remain intact.

Attempt **`6b1e2c84`** stopped before any sign-in or other mutation at **23:30:19.247 UTC** because its zero-session precondition encountered a new session. The claimant confirmed that they had signed in. A read-only snapshot at **23:31:59.766 UTC** established one session created at **23:26:42.541 UTC**, while the case remained restored and B active. The null profile, encrypted backup, original device material and canary ciphertext/deadline were unchanged; the original device was revoked and no new device had been enrolled. This was an overly strict test precondition encountering legitimate human activity, not a recovery failure. The failed receipt was preserved without rewriting it or revoking the human session.

After a separate authorization and independent source review, attempt **`9d3f7a20`** ran exactly once with that human session bound privately as a preservation requirement. All fixture writers were serialized for the operation. The supplied password was locally reverified against the exact restored credential before the single operator sign-in. The run passed at **23:35:07.641 UTC**, with exit code zero and no uncertain mutation outcomes:

- The new-password sign-in returned HTTP 200 for the exact restored, verified account. Old-cookie and old-password denial were inherited explicitly from attempt `a63df2b9`; those network requests were not repeated.
- The actual saved canary was fetched through the hosted API. Its original ciphertext and deadline matched, and the recovered historical private key decrypted and verified the original payload hash. The null profile and encrypted backup matched the pre-hold baseline.
- Exactly one new trusted device was enrolled through the ordinary challenge and dedicated recovery-key signature flow. The server atomically stored the extended encrypted backup. Every original backup entry and the dedicated recovery key were preserved; the old device stayed revoked.
- The new key alone could not decrypt the old ciphertext. A subsequent hosted canary read still decrypted correctly with the recovered historical key, demonstrating that recovery retained old-key history instead of silently redistributing old content keys.
- A compare-before-write check updated only B's private fixture password and selected device after verification. A/C were unchanged. The original B device remained in immutable private evidence and the encrypted backup.
- The exact disposable canary was deleted through the normal API. A subsequent GET returned HTTP 404, and read-only SQL confirmed row absence plus its deletion tombstone. No other content was deleted or initialized.
- Only the newly created operator session was signed out, and its saved cookie was rejected. The complete final SQL session set matched the original human-session baseline: **one preserved human session, zero operator sessions**. This does not claim account-wide zero sessions.

The immutable result and per-mutation intents are private under `recovery-after-restore-human-session-9d3f7a20`. Earlier attempts `a63df2b9` and `6b1e2c84`, the credential-verifier receipt and the human-session baseline remain separately preserved. No further hosted requests were needed to record this completed checkpoint.

The claimant also confirmed inbox receipt of **Your Porchday account access changed** after restoration. This establishes the delivered security notice for this synthetic recovery; it does not establish delivery of unrelated alert or account-email workflows.
