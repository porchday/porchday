# Member-controlled recovery release — November 12, 2026

Production web/API deployment and final audit passed. Tracking: [#228](https://github.com/porchday/porchday/issues/228), merged [PR #229](https://github.com/porchday/porchday/pull/229).

## Existing-member protection

Migration 080 is additive. Its deployment transaction asserted that zero existing accounts were marked eligible for or required to complete the new setup. Previously enrolled and previously keyless members remain exempt. The rollout does not rotate or replace their secrets, keys, backups, passwords or sessions.

Chromium/WebKit regression tests cover remembered-device unlock, original-secret restore, old encrypted content and reload while the new recovery endpoint returns 503. The API regression also enrolls a pre-migration keyless member and verifies the exemption. Hosted staging and production repeat the old-key/outage checks with isolated synthetic accounts. These tests do not claim to decrypt real members' backups; the separate production backup audit inspected only aggregate structural compatibility.

## Delivered behavior

The shared web/PWA/native-shell UI supports a locally verified saved recovery kit, PRF-capable passkeys with an independent unlock rehearsal, explicitly fingerprint-approved QR/manual/image device transfer, and two-of-three trusted contacts with consent and encrypted approvals. Existing members add methods optionally. New recovery-aware accounts verify their kit and a passkey or second device before completing setup. Method management retains original-kit access.

The platform cannot decrypt the stored recovery capsules by itself. SMS/email-only decryption and administrator-issued recovery keys are not introduced. Trust in the delivered client remains part of the security model; two colluding trusted contacts can recover a member's secret, as disclosed during setup.

## Verification and deployment

Application/frontend and production API source: a56aa1047aa07cfc1a47043f5545131be855bd56.
Staging API source: 941e5d32d5b72ea65aea2a492e3be4ea4393e2e6, preserving the existing staged partitioned cleanup runtime.
Maintained release tooling: 25556465cc8283d40092186572c47aace37bd61b.

Exact-source [web/API CI](https://github.com/porchday/porchday/actions/runs/43272694200), [secret scan](https://github.com/porchday/porchday/actions/runs/43272694039), [iOS simulator](https://github.com/porchday/porchday/actions/runs/43272694148), and [macOS tests](https://github.com/porchday/porchday/actions/runs/43272694057) passed. JS/native backup interoperability passed. Staging and production both verified virtual-PRF passkey create/test/restore, paired-device historical-content access and reload, original-kit compatibility, and actual UI recovery from two encrypted contact approvals. Synthetic accounts and content were removed and cleanup verified.

Readers deployed before writers; compatible API/frontend rollback floors were recorded before enabling recovery methods. Final audit matched provider inventory, canonical records, migration 080, native gates and hosted acceptance.

| Environment | Active API | Active frontend |
|---|---|---|
| Staging | bdb264da-f754-4d68-bb7c-0be04f331e70 | 6b256914-0e94-45f1-8c72-b3b32c18b198 |
| Production | 3c6e47b9-eb60-41ca-b8c2-24152547caad | 17138898-b2e0-46dc-9469-76261bfa442b |

All successful activations had zero failed continuity samples. The independent post-writer monitor recorded eight healthy production probes spanning 140.016 seconds, covering login, authorized reads, logout, revocation and readiness. This bounded observation is not a continuous-availability guarantee.

## Reconciled stops and remaining checks

The first staging API attempt used production's legacy cleanup-health runtime against staging's active partitioned topology. Readiness rejected stale legacy progress and the maintained controller rolled back. The revised staging source preserves that environment's runtime. A pre-command frontend check exposed a literal-import parser limitation for Rolldown backticks; corrected maintained tooling passed 33 observer/controller tests and actual old/new browser transitions. Private harness receipt and dependency-path errors were reconciled before continuation. Failed attempts remain in private release evidence and #3/#228.

Physical Apple/Google/password-manager/security-key providers, real QR-camera behavior, installed-native recovery and hosted-native interoperability remain unverified under #228/#49/#114. Exact-source native tests passed; no new signed installer, TestFlight or App Store binary was distributed. New native entitlements require a newly signed build; existing shells receive the shared UI with manual pairing/QR-image fallback. Virtual-authenticator/browser tests do not prove physical-provider behavior.
