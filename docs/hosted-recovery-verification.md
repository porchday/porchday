# Hosted stolen-account recovery verification

This is an in-progress acceptance record for synthetic account B on `https://staging.porchday.com`, using the fresh contact-verified case from attempt `d9c834ae`. It is not evidence of a completed recovery. Staff decisions must be made personally by the two authorized human reviewers; the operator does not impersonate them or bypass their reviews.

## Pre-hold baseline

Attempt `4a2c7e10` passed at **2026-10-25 21:16:40.187 UTC**. Read-only database checks confirmed the exact case was retained, contact-verified and `submitted`, with zero reviews, and B was active. The database connection enforced read-only transactions and selected no authentication/recovery tokens or secret hashes. A normal email/password sign-in confirmed the expected verified member through the deployed API.

B has no personalized profile envelope. The baseline preserves that null profile rather than creating one or claiming profile decryption. The single existing active encryption device and the encrypted recovery backup were captured as private metadata/hashes; its existing encrypted private key unlocked successfully with the saved recovery secret. No device enrollment, profile edit, password change or MFA change occurred. The private fixture state remained unchanged.

The bounded selection found no suitable existing B-authored private text post. Under explicit authorization, the runner persisted an immutable publication intent and client-generated identity, then made exactly one normal POST for an encrypted `only_me` text canary. Publication was acknowledged, and a separate API read and local signature/decryption check matched the expected payload hash. No photos, comments, reactions or other members were involved. The canary expires at **2026-10-26 21:16:38.092 UTC**. Its original ciphertext, author public key and decrypted-payload hash are saved privately for comparison after recovery.

All evidence files are mode `0600` beneath the protected, ignored `artifacts/private/hosted-smoke/` directory, using the prefix `recovery-prehold-4a2c7e10`. The `.session.json` file contains the captured session capability and must never be published. The `.intent.json`, `.canary-intent.json`, `.old-ciphertext.json`, `.baseline.json` and `.result.json` preserve the exact boundaries and expected evidence. No passwords, cookies, private keys, email addresses, subject/member identifiers or decrypted content appear in this document.

## Deliberately outstanding session and canary

**One new session remains intentionally live** so the human-applied hold can demonstrate its revocation. Four pre-existing B session rows were also observed; this baseline did not revoke or attribute them. It does not claim that all sessions are closed.

The coordinating operator and the service task own these cleanup obligations:

- After the authorized human hold, verify that the captured old cookie no longer grants access. Do not create a replacement login merely to prepare that check.
- After the separate two-person approval and claimant restoration, verify old-access denial and recovery of the saved ciphertext with the original encryption recovery material. These checks have not happened yet.
- Delete the newly created canary through the normal authorized API after verification. Its 24-hour deadline is a fallback, not proof that cleanup has already occurred.
- If the test is canceled before the hold, normally sign out the deliberately retained session and verify denial. Never silently abandon its private capability or report blanket cleanup without evidence.

At this checkpoint the operator had separately verified the two staging recovery-role grants at **21:14:58.418 UTC**. Actual human queue access, the hold, distinct approvals, restoration-email use and completed recovery remain pending. No additional hosted request was made after the successful baseline while awaiting the human hold.

## Preserved initial guard failure

Attempt `2fbb68d9` stopped at **21:13:45.847 UTC** because the harness incorrectly required an encrypted profile for B. The actual null profile is a valid fixture state, not an application defect. This attempt made no profile/content change or recovery decision. Its new session was normally signed out, and the saved cookie was independently rejected with HTTP 401. The failed receipt remains unchanged. The later attempt accepts the known null profile explicitly and supplies separate, authorized old-ciphertext evidence instead of manufacturing a profile.
