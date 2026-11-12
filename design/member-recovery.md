# Member-controlled encryption recovery

Tracking: [#228](https://github.com/porchday/porchday/issues/228). Requested by the operator on November 12, 2026. This design does not grant operators access to member keys.

## What is backed up

The existing `/keys/backup` envelope stores OpenPGP-encrypted private keys for historical devices and a separate recovery-only signing key. Device keys decrypt content keys and sign contributions. The recovery signing key authorizes replacement encryption devices. Media ciphertext stays in existing media storage; this is not another media copy. Login passwords and MFA backup codes are separate from encryption recovery.

The random 256-bit recovery secret currently protects both sorts of private key. The server stores the encrypted key envelope, not that secret. A new recovery method would protect a copy of the recovery secret (a recovery capsule) or transfer existing device keys between member-approved devices. It must not replace public-key trust based on login authentication alone.

## First implementation: verify the saved secret

New web and shared Swift onboarding hide the displayed secret after the member says it is saved, then require retrieval of the saved copy and actual local decryption of every backup key, including recovery authority. Account settings provide the same read-only rehearsal. Verification does not enroll devices, rotate keys, update the server or save the supplied secret. Failure leaves the account and active device intact. Errors are fixed messages, and the UI excludes recovery material from diagnostics.

This catches incomplete or wrong copies; it cannot prove the member stored the secret durably rather than temporarily copying it. Recommend a password-manager entry and an independent private backup. Do not claim the check guarantees recovery forever or verifies future backups.

## Additional methods — still to implement

### Trusted-device transfer

A new device creates a key pair and requests a fresh existing enrollment challenge. An already unlocked device verifies a QR/manual fingerprint over a trusted channel, obtains explicit approval, signs the purpose/account/device/fingerprint/challenge/expiry statement, and encrypts historical device private keys to the approved new key. The recovery-only signing key is never left on an ordinary unlocked device. Replay, expiry, cancellation, revocation and cross-account checks apply before enrollment and before consuming transfer material. Retain a recovery kit because losing every device defeats this method.

### Passkey-protected capsule

Use WebAuthn PRF to derive a wrapping key on the member device and authenticated encryption to protect the existing recovery secret. Ordinary passkey login does not provide this encryption key. Bind version, member identity, recovery public-key fingerprint, credential identity and capsule ID as authenticated metadata. Do not send PRF outputs, plaintext secrets or decrypted private keys to the server.

Enrollment must first verify the existing secret, then prove that the saved credential can unlock the capsule. Reject unsupported authenticators without altering current recovery. Test actual Safari/PWA and native WKWebView behavior; introduce a native bridge only where needed. Keep an independent recovery kit. Registration, list/delete, replacement, authentication freshness and signed changes need a reviewed protocol before storage endpoints are added.

Reference: [W3C PRF explainer](https://github.com/w3c/webauthn/blob/main/explainers/prf-extension.md). PRF supplies secret output for client-side encryption; it is not an administrator recovery mechanism.

### Explicit trusted contacts

Proposed default: two of three explicitly chosen contacts. No operator role receives a share automatically. A sufficient set of colluding contacts can recover the account; disclose this before enrollment. Shares need authenticated encryption to verified contact keys, explicit contact acceptance, versioning, confirmation that enough distinct contacts have accepted, and safe replacement/revocation behavior. Recovery approvals must bind the member, recovery setup version, fresh request and requesting device key. Contacts must verify the human requesting help outside the compromised account session.

Select and review an established threshold implementation rather than writing field arithmetic ad hoc. Test mismatched and duplicate shares, wrong accounts, stale setups, revoked contacts, expired/replayed approvals, lost devices and concurrent changes. Previously copied shares cannot simply be recalled; revocation requires a protocol that prevents an old threshold from recovering current authority, with explicit limits for old copied ciphertext.

## Limits and release status

None of these methods can reconstruct keys after every configured recovery factor is lost. They must be set up while a member still has access. Encrypted backups protect against routine server/database access; a malicious operator who can ship client code remains a separate threat described in `docs/crypto-protocol.md`.

Only the first local-verification implementation is present in this branch. Additional methods are not released, and no production deployment is claimed. Native source changes cover both iOS and macOS shared Swift screens and the shared web shells. Automated native and hosted/device verification must be recorded separately before release.
