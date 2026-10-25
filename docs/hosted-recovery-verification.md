# Hosted stolen-account recovery verification

This is an in-progress acceptance record for synthetic account B on `https://staging.porchday.com`, using the fresh contact-verified case from attempt `d9c834ae`. It is not evidence of a completed recovery. Staff decisions must be made personally by the two authorized human reviewers; the operator does not impersonate them or bypass their reviews.

## Pre-hold baseline

Attempt `4a2c7e10` passed at **2026-10-25 21:16:40.187 UTC**. Read-only database checks confirmed the exact case was retained, contact-verified and `submitted`, with zero reviews, and B was active. The database connection enforced read-only transactions and selected no authentication/recovery tokens or secret hashes. A normal email/password sign-in confirmed the expected verified member through the deployed API.

B has no personalized profile envelope. The baseline preserves that null profile rather than creating one or claiming profile decryption. The single existing active encryption device and the encrypted recovery backup were captured as private metadata/hashes; its existing encrypted private key unlocked successfully with the saved recovery secret. No device enrollment, profile edit, password change or MFA change occurred. The private fixture state remained unchanged.

The bounded selection found no suitable existing B-authored private text post. Under explicit authorization, the runner persisted an immutable publication intent and client-generated identity, then made exactly one normal POST for an encrypted `only_me` text canary. Publication was acknowledged, and a separate API read and local signature/decryption check matched the expected payload hash. No photos, comments, reactions or other members were involved. The canary expires at **2026-10-26 21:16:38.092 UTC**. Its original ciphertext, author public key and decrypted-payload hash are saved privately for comparison after recovery.

All evidence files are mode `0600` beneath the protected, ignored `artifacts/private/hosted-smoke/` directory, using the prefix `recovery-prehold-4a2c7e10`. The `.session.json` file contains the captured session capability and must never be published. The `.intent.json`, `.canary-intent.json`, `.old-ciphertext.json`, `.baseline.json` and `.result.json` preserve the exact boundaries and expected evidence. No passwords, cookies, private keys, email addresses, subject/member identifiers or decrypted content appear in this document.

## Baseline session and canary obligations

**At the pre-hold checkpoint, one new session remained intentionally live** so the human-applied hold could demonstrate its revocation. Four pre-existing B session rows were also observed; the baseline did not revoke or attribute them. The later hold check below fulfills the saved-session revocation obligation. Canary cleanup remains outstanding.

The coordinating operator and the service task own these cleanup obligations:

- After the authorized human hold, verify that the captured old cookie no longer grants access. Do not create a replacement login merely to prepare that check.
- After the separate two-person approval and claimant restoration, verify old-access denial and recovery of the saved ciphertext with the original encryption recovery material. These checks have not happened yet.
- Delete the newly created canary through the normal authorized API after verification. Its 24-hour deadline is a fallback, not proof that cleanup has already occurred.
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

The human claimant has been asked to use the delivered restoration form with the separately prepared private password, then stop at **Your login access is restored** before signing in or unlocking encryption keys. The post-restoration harness is prepared and independently reviewed, but has not run. No additional hosted requests were made to create this documentation checkpoint. Claimant completion, old-password denial, recovery of the original ciphertext, one normal recovery-authorized device enrollment, private fixture-state reconciliation, canary deletion and final session cleanup remain pending.
