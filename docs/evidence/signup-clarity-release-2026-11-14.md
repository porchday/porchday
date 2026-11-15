# Signup and recovery clarity release — November 14, 2026

Follow-up for #228 and #27; implementation PR #233.

## Behavior

Signup emails and first-time private-sharing setup distinguish account login from access to encrypted content. New members save and locally check a recovery note, then create a tested spare key or pair another private device. Passkeys are explained before the action; optional naming and advanced controls stay out of the main walkthrough. Continue appears only when the existing server prerequisites are satisfied. Existing members remain exempt from mandatory setup.

Recovery, login, resend, email settings and two-step-sign-in feedback appears beside its initiating control and is brought into view. Checking a saved note preserves the input for passkey creation. Cancellation retains that input; unavailable providers offer another-device guidance. Removed methods and revoked devices retain local confirmation while disabling the completed action.

## Automated acceptance

Thirty focused checks covered Chromium/WebKit feedback placement, cancellation and unsupported providers, virtual PRF enrollment, local signup/verification email delivery capture, server pairing readiness, old-key access during recovery-service failure, and removal/revocation feedback. Full-source CI, hosted acceptance and deployment evidence are recorded below after completion.

## Limits

Virtual authenticator and browser/native CI results do not establish physical-device, provider-sync, camera, inbox, signed installer or TestFlight acceptance. Those remain tracked under #228, #27, #49 and #114. This release does not change the encryption format, grant the operator a recovery credential, or impose a new setup requirement on existing members.

## Deployment and hosted verification

PR #233 merged as `2488060cfecdd96c545cc6ba49da28683085f1e5`. Tested application source: `5dc0085b59f8dc699364b0aa01f64a9609370337`. Staging API source: `a9045f36133b9581821383e31d461ea79239ddbd`, preserving its previously staged runtime changes. Release tooling: `25556465cc8283d40092186572c47aace37bd61b` with the maintained native parity gate.

Exact-source checks passed: [web/API CI](https://github.com/porchday/porchday/actions/runs/43660960901), [secret scan](https://github.com/porchday/porchday/actions/runs/43660960899), [iOS simulator](https://github.com/porchday/porchday/actions/runs/43660960951), [macOS build/tests](https://github.com/porchday/porchday/actions/runs/43660960914), and [staging CI](https://github.com/porchday/porchday/actions/runs/43660967377).

Final audit passed at 2026-11-15T01:30:19.928Z. Active versions:

| Environment | API | Frontend |
| --- | --- | --- |
| Production | `a1d2b557-07e5-4329-9239-90f5ac9a59ab` | `8a6fb19f-111a-47bb-b458-25b118cfdacc` |
| Staging | `7f91e2b0-f9b4-447a-a3f7-c3ba780f1020` | `dc06b177-0b74-4d5f-b583-76bd34e1b3fb` |

Both environments passed actual hosted first-time setup to Feed, adjacent phone-sized feedback, virtual PRF enrollment and recovery, device pairing with history/reload, two-contact recovery, and original-secret access while recovery metadata returned a simulated 503. All owned synthetic accounts were removed. Provider state matched the canonical deployment record; schema and recovery reader floors were unchanged. Existing tabs retained their immutable assets. Production monitoring recorded 17 healthy cycles across 320 seconds, with no failed samples and a maximum journey of 2,687 ms.

A staging frontend attempt failed four 5-second continuity samples after its browser check. The maintained controller rolled it back, fixtures were removed, and a fresh observed attempt passed. The original failure is preserved, not counted as acceptance. Its unknown cause is tracked in [#55](https://github.com/porchday/porchday/issues/55#issuecomment-6887207662). A local evidence-permission failure and incomplete retry preparation also stopped before activation and were corrected with the original records retained.

Private evidence archive: `artifacts/private/signup-clarity-20261114`; no credentials, member data or recovery material are included in this document.
