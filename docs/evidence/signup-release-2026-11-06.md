# Signup and Feed label release — November 6, 2026

Implemented in [PR #164](https://github.com/porchday/porchday/pull/164), with the release artifact verifier correction in [PR #165](https://github.com/porchday/porchday/pull/165).

The chronological view button is now **Feed** on web and shared iOS/macOS. Invitation and verification emails explain the next step, expiry and invited-address requirement. Signup folds a validated invitation code, explains connection/history behavior, and ends on a dedicated check-email screen with a resend cooldown. Verification leads to a server-confirmed result and a focused login form; expired, reused and invalid links have recovery guidance. Password, two-factor, invitation binding, rate limits and private-content recovery safeguards remain intact.

The [larger-video design](../../design/larger-videos.md) is a proposal only. Its suggested 10-minute / 250 MiB prepared-video limits, local preparation and resumable encrypted segments are not enabled by this release.

## Deployed sources

| Component | Source | Staging version | Production version |
| --- | --- | --- | --- |
| Web/frontend | `bd24cdb` | `e2bd14ed-1c98-44f7-9319-867ff5c5ee3b` | `44ec2b33-f8e4-40ef-882f-55b78080efc0` |
| API | staging `64ce5eb`, production `8407e30` | `734afca3-c8f6-40cc-aac5-e0c936a32f3c` | `3c5fa420-ed3d-4c81-b114-40407393813f` |

API candidates preserve each environment's deployed runtime and include the signup changes, relevant tests and current shared native source. No database migration was required. The 150-connection limit remains in force.

## Validation

- Web build/typechecking, Chromium/WebKit signup journeys, unified Feed regression checks, signed receipt tamper/expiry tests and invitation context tests passed.
- PostgreSQL integration coverage passed: 39 invitation tests and 31 authentication/privacy-journal tests, with the exact final verification path rerun after copy changes.
- Full CI, secret scanning, macOS build/tests and iOS simulator build/tests passed for all three final sources. The native UI test now locates the age attestation in the scrollable signup form.
- Hosted staging and production checked read-only invitation context, folded invitation codes, spoofed URL flags, actual verification commit, trusted success display, reused/expired/invalid links, normal login and logout. Isolated synthetic accounts, invitations and sessions were cleaned up; no real member data was used.
- Legacy domain/root routes, PWA checks and retained-asset compatibility passed. Final production API and frontend activations each recorded 16 continuity samples with zero failures.
- Independent production monitoring and the final provider/schema/source/native/cleanup audit passed. Private proofs and credentials are not included in this document.

Native implementation and automated build availability are separate from signed installer, TestFlight and App Store distribution. This release does not claim new native store submissions or physical-device acceptance. Email content is covered by captured-delivery tests; actual inbox delivery remains unverified. [#27](https://github.com/porchday/porchday/issues/27) remains open for inbox/device acceptance and the original unconfirmed recipient report. The larger-video proposal and media device follow-up remain under [#108](https://github.com/porchday/porchday/issues/108).

## Release reconciliation

The provider preserved the original source-map root while normalizing paths in an inactive staging upload. The executable, mappings, names and source contents were unchanged. The verifier was narrowly updated to recognize that exact provider format and regression-tested; the original upload was reconciled read-only, without replay or activation. A later native test-only correction superseded that inactive candidate. The final release used reviewed tooling `bfda3dc`, including native parity enforcement and the existing full queue inventory. [#3](https://github.com/porchday/porchday/issues/3) retains release reliability follow-up.
