# Typed handles and multi-select tagging — November 11, 2026

Implementation: [PR #222](https://github.com/porchday/porchday/pull/222), source `07da2e830fd4f3232b32c9f8a0547ef5d739cdf1`, merge `61217e7033447305973f8583e42c9916797e7a55`. Tracking: [#125](https://github.com/porchday/porchday/issues/125).

## Delivered behavior

Typing a recognized @handle creates an encrypted stable member tag in post text, photo/video captions, comments and replies, including independent-photo comments. Linked rendering uses stored member identity. The searchable checkbox picker stays open for multiple selections; manually selected tags remain independent of typed references.

Resolution is restricted to self/current connections and does not change sharing audiences or encryption recipients. Unknown handles remain plain text. Handles are case-insensitive ASCII letters, numbers and underscores, 3–24 characters; supported delimiters include whitespace, newlines and common punctuation. Emails, URLs and escaped @ signs are excluded. Duplicates merge by identity, removing a typed reference removes its generated tag, and editing preserves the prior identity rather than following a reassigned handle. Child profiles remain explicit selections. The existing 30-tag limit applies per field.

Default iOS/macOS shells receive the shared UI without a new signed binary. Existing payloads, drafts and explicit tags remain compatible. Native distribution availability remains separate from source validation.

## Verification

- Local tests: 1,377 passed / 327 skipped; skipped tests are not claimed verified. Seven new tokenizer/identity regression tests passed.
- Chromium and WebKit: real typed-entry/picker/link rendering, repeated selection, duplicate handling, unknown/email text, saved edit/removal and explicit-tag retention passed.
- Actual Composer payload and existing calendar, encrypted draft and clickable-link browser checks passed.
- Exact-source full CI [43056971264](https://github.com/porchday/porchday/actions/runs/43056971264) and PR CI [43057006115](https://github.com/porchday/porchday/actions/runs/43057006115) passed, as did secret scan and focused post-detail/invitation/reaction checks.
- iOS [43056971238](https://github.com/porchday/porchday/actions/runs/43056971238): 152 unit tests, four skipped, zero failures; three UI tests passed.
- macOS [43056971267](https://github.com/porchday/porchday/actions/runs/43056971267): 86 tests, zero failures.
- Exact deployed assets, retained open-tab assets, forward/rollback browser checks and native-bridge browser smoke passed.
- Staging and production: actual synthetic encrypted post, photo caption and comment typed handles survived storage/decryption/reload and rendered the stable member link while preserving Only me sharing. Draft restoration, safe automatic updates, confirmed-post handoff, media cache authorization, deletion failure/retry, settings and diagnostic recording regressions also passed. Synthetic fixture cleanup verified zero remaining rows.

## Deployment

Maintained activation CLI with native parity enforcement completed both environments. No backend or database migration was needed.

| Environment | Frontend version | Candidate continuity |
| --- | --- | --- |
| Staging | `2e650b99-a8ab-4d7e-bfea-880ff9a3a006` | 18 samples, zero failures |
| Production | `6e75e2f4-fa99-43a2-993a-71a98194ff57` | 18 samples, zero failures |

An initial staging activation-preparation attempt was rejected because a newly written local evidence file had mode 0644. It was corrected to 0600; original failed preparation evidence was preserved. No activation manifest or activation intent existed at that point. The completed upload was reused, and all maintained validation gates then passed.

Post-release independent production monitoring passed: 8 healthy samples spanning 140.0 seconds, zero failures.

## Remaining verification

Physical iPhone/macOS typing, checkbox selection and keyboard behavior remain `needs verification` in #125. Browser/native automated checks are not physical-device acceptance. Mention-specific notifications from the broader original issue are not implemented here; existing audience-scoped notifications are unchanged and remain tracked under #7. The issue remains open for those acceptance items.

Private operational evidence: `artifacts/private/typed-mentions-20261111` (not committed).
