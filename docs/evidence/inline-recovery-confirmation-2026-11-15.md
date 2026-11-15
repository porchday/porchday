# Inline recovery confirmation — November 15, 2026

Implemented in [PR #238](https://github.com/porchday/porchday/pull/238), tracked under [#228](https://github.com/porchday/porchday/issues/228). Production/backend and frontend revision: `d8c8d7a38b2dc806b8fa6746bd061eeda8b1f0d7`; merge commit: `fcbf81dabb8c72f58fe1c235e3935b1ff3dd0a8e`. Staging backend revision: `45a23b3e7ea8ffb7ca749316f07e482482c6485f`, preserving its isolated cleanup implementation.

## Behavior and safeguards

When a recovery action needs authentication newer than 15 minutes, a password confirmation appears beside that action. Enabled two-factor authentication also requires the current authenticator code. Success resumes the action without navigating away, logging out or clearing the local recovery form. Cancellation and invalid credentials keep the form intact.

The server verifies the current member’s password through the existing authentication library. It validates the current session and account status, enforces same-origin requests, rate-limits by member and address, and requires enabled MFA. A signed HttpOnly secure cookie authorizes only key-backup/device recovery endpoints for 15 minutes and is bound to the validated member and session. It does not authenticate a missing/revoked session or grant recent authentication to account deletion or password-change endpoints. The login session is not replaced. Confirmation credentials remain in component memory; recovery secrets are checked locally and never included in confirmation requests or diagnostics.

No schema migration, ciphertext change, recovery-key replacement, existing-member eligibility change, or recovery reader-floor change was made. The API was activated before the frontend, preserving the old fresh-login behavior for existing clients.

## Verification

- 46 focused tests passed: full authentication-journal integration suite, confirmation cookie scope/tampering/expiry, recovery walkthroughs in Chromium/WebKit, and legacy recovery checks. Final password/MFA and rate-limit tests passed after the lockout check was added.
- All workspace typechecks, formatting, full release CI and history secret scanning passed. Historical prose falsely detected as a credential received an exact path/value exception; no credential exception was added.
- [Web CI](https://github.com/porchday/porchday/actions/runs/43746849044), [iOS simulator CI](https://github.com/porchday/porchday/actions/runs/43746849121), and [macOS CI](https://github.com/porchday/porchday/actions/runs/43746849069) passed for the production revision.
- Hosted staging and production used synthetic members with real encrypted key backups and hour-old sessions. Both password-only and MFA flows passed cancellation, wrong-password handling, local recovery-secret verification, and automatic continuation. Session IDs/expiry were unchanged. Requests excluded the recovery secret, and another member’s grant was rejected.
- Owned synthetic accounts and sessions were removed. No real member was used for acceptance.
- API and frontend activation windows each had 13 healthy continuity samples on staging and 14 on production, with zero failures. Retained assets and old-tab forward/rollback compatibility passed.

Independent production monitoring passed eight samples over 140 seconds with zero failures. The final provider/version/schema/native audit passed, confirmed unchanged recovery reader floors, and found no held deployment lease. No monthly availability claim is made.

## Active versions

| Component | Version |
| --- | --- |
| Production API | `ef044b8c-304f-4e3f-83f9-5e1e0f88aa7b` |
| Production frontend | `49a44664-2edf-4310-9c80-9212dd5dc6b4` |
| Staging API | `14456dda-f48d-47f4-9b58-cb7798694d7d` |
| Staging frontend | `f5efa3ba-b189-47b3-8e16-fedfe9374ddf` |

## Native and device acceptance

Default iOS/macOS persistent WKWebView shells share this implementation without a bridge change. Exact-source simulator/build checks passed; no new signed binary was distributed. Physical-device keyboard, autofill and installed-app acceptance remain **needs verification** under #228, #49 and #114. Automated browser checks do not claim those checks.
