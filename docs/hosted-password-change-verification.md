# Hosted authenticated password-change verification

On October 25, 2026, one authenticated password change on synthetic staging account A passed the core hosted acceptance checks. The application was the deployed `c9339a7` release at `https://staging.porchday.com`. This used normal authentication endpoints and the existing guarded `SmokeClient`; SQL access was read-only and limited to A's session metadata. No production account, other synthetic account, content, device, encryption key, or infrastructure was changed.

## Result and cleanup evidence

Attempt `51e8c2a6` started at **20:55:15.142 UTC**. The single password-change request was preceded by an immutable private intent at **20:55:21.762 UTC** and acknowledged at **20:55:25.452 UTC**. It verified:

- Both saved pre-change session cookies were rejected with HTTP 401.
- One sign-in using the old password was rejected with HTTP 401.
- Sign-in using the new password succeeded as the same verified, active member.
- The encrypted profile, complete device listing, encrypted key backup, and locally decrypted profile payload had identical hashes before and after the change.
- Both the normal session-list endpoint and a read-only SQL check showed exactly the new session. None of the nine pre-change sessions remained.
- The private fixture state was replaced only after the new login and history checks passed, with a whole-file compare-before-write guard. A subsequent local read confirmed that A's saved password matched the confirmed new password. The old password was not restored.
- The new session was signed out. The final read-only SQL check found **zero A session rows**, including expired rows, before the result receipt completed at **20:55:33.649 UTC**. No later login or hosted request was made for this acceptance.

The preserved runner receipt reports `passed:false` and two `SESSION_CLEANUP_UNCONFIRMED` entries because its finalizer also attempted redundant sign-outs after the old sessions had already been revoked. It nevertheless records `passwordChangeAcknowledged:true`, `privateStateUpdated:true`, `previousSessionsRevoked:true`, `oldSessionsDenied:true`, `oldPasswordDenied:true`, `newPasswordLogin:true`, `encryptionHistoryUnchanged:true`, and `finalSessionCount:0`. This is a core acceptance pass with confirmed final cleanup, not a claim that the runner exited successfully. The receipt was not rewritten, and no extra password change, session revocation, or login was used to conceal the finalizer error.

The private state update and final SQL query do not have separate per-step timestamps; **20:55:33.649 UTC** is their enclosing completion bound. The unused intent from the earlier stopped attempt and all result receipts remain private under `artifacts/private/hosted-smoke/`. Passwords, cookies, member IDs, key material, raw responses, and decrypted content were not published.

## Exact pre-existing session boundary

Earlier attempt `adc729b4` stopped at **20:49:01.301 UTC**, before submitting a password change, when the expected two-session baseline contained seven additional active sessions. Its own two sessions were closed; it did not alter the password or send a password-change notification.

A read-only inspection at **20:50:28.287 UTC** found seven active, unexpired sessions, all classified as Node clients, with created/updated times of 16:20:59.551, 16:34:18.401, 16:58:35.599, 17:00:17.595, 17:02:25.685, 17:32:47.406, and 17:34:45.077 UTC. Each expired seven days later. The session-list endpoint excludes expired sessions; these were not expired rows accidentally counted by the guard.

The second attempt required exactly those seven timestamps, expiry times, active statuses, and Node classifications, privately bound their row IDs, and rechecked the complete baseline immediately before the change. It accepted only those seven plus its two fresh sessions. Any other session, including a browser, native, or unknown client, would have stopped the attempt. The normal password change was explicitly authorized to revoke this entire synthetic baseline; no separate revocation calls were made.

These are QA-compatible sessions, not individually proven historical run attributions. The [restore-fixture runner](../scripts/hosted-restore-fixtures.ts) deliberately retains sessions so isolated replay can demonstrate their invalidation. Its source explains why earlier statements that a particular test's sessions were closed did not establish that every A session from every prior run was absent. This acceptance's final SQL check does establish zero A session rows at its recorded completion bound.

## Limits

This checks authenticated password change over the actual hosted HTTP API, not password-reset email links, email-address change, browser form accessibility, or stolen-account restoration. The application queues its normal security notification after a successful password change; **inbox receipt remains unverified**. The test does not substitute for independent security review.
