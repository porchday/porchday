# Hosted MFA verification

On October 25, 2026, a bounded test against `https://staging.porchday.com` passed using synthetic account B and normal authentication endpoints. It used the existing guarded `SmokeClient` and the maintained OTP helper already used by `auth-journal.integration.test.ts`. It did not use staff access, database writes, injected sessions, email-token extraction or a server test bypass.

The test enabled two-factor authentication with B's existing password, stored the returned authenticator setup and backup codes only in a protected local file, and confirmed enrollment with a valid TOTP. A fresh password sign-in then required a second factor; `/api/v1/me` returned 401 until the authenticator code was verified. A separate sign-in accepted one backup code. A subsequent challenge rejected replay of that used code and still denied member access; a valid TOTP completed that challenge.

The test disabled MFA through the normal authenticated endpoint, signed out, and confirmed a new login succeeded with the unchanged original password and MFA disabled. Hashes of B's device listing and encrypted key backup were identical before and after. No content, encryption-device, password or email mutation endpoint was used. B remains active for the separate restore, browser and recovery-contact checks.

The operator returned `passed:true`, `cleanup:true` and `mfaDisabled:true`; all test sessions signed out. A separate local check confirmed the temporary `mfa-pending.json` setup file was absent. Only fixed status labels were printed; OTP secrets, backup codes, passwords, cookies and raw HTTP responses were not published. The sanitized result is retained locally under `artifacts/private/hosted-smoke/mfa-result.json`; it contains no credential values.

This was an actual hosted HTTP/authentication test, not a browser or native authenticator UI test. It checked one used-code rejection, not the full lockout threshold, and does not replace the independent security review. The user-facing stolen-account contact email flow and two-reviewer restoration are separate checks; this test sent no recovery mail and did not approve or restore a recovery case.
