# Member-controlled encryption recovery

Tracking: [#228](https://github.com/porchday/porchday/issues/228). Requested by the operator on November 12, 2026. This design does not grant operators access to member keys.

## What is backed up

The existing `/keys/backup` envelope stores OpenPGP-encrypted private keys for historical devices and a separate recovery-only signing key. Device keys decrypt content keys and sign contributions. The recovery signing key authorizes replacement encryption devices. Media ciphertext stays in existing media storage; this is not another media copy. Login passwords and MFA backup codes are separate from encryption recovery.

The random 256-bit recovery secret currently protects both sorts of private key. The server stores the encrypted key envelope, not that secret. A recovery method protects a copy of the recovery secret (a recovery capsule) or transfer existing device keys between member-approved devices. It must not replace public-key trust based on login authentication alone.

## First implementation: verify the saved secret

New web and shared Swift onboarding hide the displayed secret after the member says it is saved, then require retrieval of the saved copy and actual local decryption of every backup key, including recovery authority. Account settings provide the same read-only rehearsal. Verification does not enroll devices, rotate keys, update the server or save the supplied secret. Failure leaves the account and active device intact. Errors are fixed messages, and the UI excludes recovery material from diagnostics.

This catches incomplete or wrong copies; it cannot prove the member stored the secret durably rather than temporarily copying it. Recommend a password-manager entry and an independent private backup. Do not claim the check guarantees recovery forever or verifies future backups.

## Implemented additional methods (candidate, not yet released)

### Trusted-device transfer

A new device creates a key pair and requests a fresh existing enrollment challenge. An already unlocked device verifies a QR/manual fingerprint over a trusted channel, obtains explicit approval, signs the purpose/account/device/fingerprint/challenge/expiry statement, and encrypts the historical device private keys available on the approving device to the approved new key. The recovery-only signing key is never left on an ordinary unlocked device. Replay, expiry, cancellation, revocation and cross-account checks apply before enrollment and before consuming transfer material. Retain a recovery kit because losing every device defeats this method.

### Passkey-protected capsule

Use WebAuthn PRF to derive a wrapping key on the member device and authenticated encryption to protect the existing recovery secret. Ordinary passkey login does not provide this encryption key. Bind version, member identity, recovery public-key fingerprint, credential identity and capsule ID as authenticated metadata. Do not send PRF outputs, plaintext secrets or decrypted private keys to the server.

Enrollment must first verify the existing secret, then prove that the saved credential can unlock the capsule. Reject unsupported authenticators without altering current recovery. Test actual Safari/PWA and native WKWebView behavior; introduce a native bridge only where needed. Keep an independent recovery kit. Storage changes require a fresh active-device signature; immutable method IDs, per-action nonces and account-bound ciphertext prevent cross-method replay. Replacement is add-and-test, then remove the old method.

Reference: [W3C PRF explainer](https://github.com/w3c/webauthn/blob/main/explainers/prf-extension.md). PRF supplies secret output for client-side encryption; it is not an administrator recovery mechanism.

### Explicit trusted contacts

Default: two of three explicitly chosen contacts. No operator role receives a share automatically. A sufficient set of colluding contacts can recover the account; disclose this before enrollment. Shares need authenticated encryption to verified contact keys, explicit contact acceptance, versioning, confirmation that enough distinct contacts have accepted, and safe replacement/revocation behavior. Recovery approvals must bind the member, recovery setup version, fresh request and requesting device key. Contacts must verify the human requesting help outside the compromised account session.

The implementation pins `shamir-secret-sharing` 0.0.4 (Privy, MIT), using its 2-of-3 split/combine primitives; no custom field arithmetic. The upstream library documents Cure53 and Zellic audits. Those audits do not cover Porchday’s integration. Test mismatched and duplicate shares, wrong accounts, stale setups, revoked contacts, expired/replayed approvals, lost devices and concurrent changes. Previously copied shares cannot simply be recalled; revocation requires a protocol that prevents an old threshold from recovering current authority, with explicit limits for old copied ciphertext.

## Limits and release status

None of these methods can reconstruct keys after every configured recovery factor is lost. They must be set up while a member still has access. Encrypted backups protect against routine server/database access; a malicious operator who can ship client code remains a separate threat described in `docs/crypto-protocol.md`.

The full implementation is a release candidate, not yet deployed. The default iOS/macOS WKWebView shells use the same recovery UI and encryption flow. Associated-domain webcredentials and scoped camera permission are implemented in native source. Legacy Swift backup readers understand paired-device key envelopes too. Exact-source native CI and hosted rollout verification remain required; physical Apple Passwords, Google Password Manager, 1Password, and security-key checks remain explicitly pending.

## Enrollment and compatibility

Migration 080 marks every preexisting member ineligible for mandatory second-method onboarding, including members who have not enrolled encryption keys yet. New members opt into the requirement only during first encryption enrollment by a recovery-aware client while `KEY_RECOVERY_ENABLED=true`. They verify a saved kit and a tested passkey or completed second-device pairing. Existing members receive an optional, dismissible suggestion and retain normal access.

Deploy compatible backup readers with the feature flag disabled before enabling creation of wrapped paired-device backups. Keep that reader-capable version as the rollback floor. Existing open tabs should reload before recovery; ordinary key use remains compatible. Never roll back to a reader that assumes every device key is passphrase-wrapped after a paired backup exists.

Pairing invitations expire in four minutes; requester QR codes in nine minutes; contact requests in 23 hours. Invitations are single-use, approvals bind the full recipient fingerprint, and pairing still requires explicit confirmation on the trusted device. Camera, QR image and manual code entry are supported in both directions. Temporary requester keys persist only in the existing encrypted local vault after private-device consent. No recovery secret or recovery-only signing key is persisted on an ordinary paired device.

## Verification

Local Chromium and WebKit tests pair distinct browser contexts through the actual manager/unlock UI, decrypt older content, reload successfully, and restore the new device key with the original kit. The QR image path exercises the actual decoder. Chromium virtual WebAuthn tests prove PRF capsule recovery and reject unsupported authenticators. Real PostgreSQL runtime-role tests exercise enrollment, grandfathering, contact separation, cancellation, replay, invitation consumption, expiry and revoked-device authorization. JavaScript-to-Go interoperability verifies paired backup decryption and rejects changed context, signer and key identity. Automated tests are not evidence of physical-provider compatibility or independent cryptographic review.

A trusted device transfers its available historical keys, including its own key; it does not need private keys created later on other devices. Pairing preserves every existing backup entry and appends the new wrapped key. Repeating receipt after an interrupted enrollment reconciles the existing device identity before saving history, instead of attempting duplicate enrollment. The original kit remains the complete historical-key backup.
