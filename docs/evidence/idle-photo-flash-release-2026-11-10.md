# Idle photo flashing fix — November 10, 2026

Implemented and deployed through [PR #217](https://github.com/porchday/porchday/pull/217), tracked in [#168](https://github.com/porchday/porchday/issues/168).

## Confirmed cause

Background history sharing reserves, uploads and cleans up media, then refreshes one post/photo audience. The API client previously broadcast a full photo-cache invalidation after each successful write. Every mounted image discarded its object URL and reopened, including unrelated photos the member was viewing without scrolling. Consented request metadata showed unrelated media downloads shortly after these writes. No member content or identifiers are included in this report.

The regression reproduces against the prior production implementation with diagnostics disabled. Diagnostic capture/upload does not itself call photo invalidation; the fixed regression also runs with content recording enabled. Recording does not need to be disabled.

## Fix

- Media reservation/upload/cleanup invalidates only the identified media. Known history-refresh routes invalidate the signed parent instead of every photo.
- Parent identity comes from the verified decrypted media envelope. Signed root media stays mounted during unrelated parent updates; unknown/pending ownership remains conservative.
- Broad access mutations, access denial, account/key changes, backgrounding and logout retain full invalidation. A change to the displayed photo still invalidates it; signed expiry and warm-cache HEAD authorization remain enforced.
- Invalidated pending work cannot revive old pixels or delete a newer replacement result. Known unrelated work remains intact.

## Live release

Reviewed frontend source: `36f3ea8fd42c321d2679ca64fb24ded6e176add4`. No backend, schema, telemetry consent, native bridge or signed-binary distribution change.

| Environment | Active edge/UI version | Retained-asset rollback version |
| --- | --- | --- |
| staging | `11eee53e-aaff-4de1-a7f4-e3192453ffce` | `d981a7c3-a3f2-408f-b371-277e71c14f56` |
| production | `b26c5ae7-0fe2-4bdf-979d-462876309c1e` | `e0a96c14-a855-4728-8779-e3fa6de4a976` |

Production acceptance: 2026-11-10T15:40:50.604Z. Retained backend sources: staging `a09bb07d251f146d31428fb61fff0bc44df164a3`, production `40015c0640601d11728f1e77f4cbdd9b48f80ec1`. Activation used maintained native-parity-gated tooling `cce72b4ce5e486b5413ffa0b7cac43dadcb471e6`.

## Validation

- [Verify Porchday](https://github.com/porchday/porchday/actions/runs/42840699177).
- [Secret scan](https://github.com/porchday/porchday/actions/runs/42840699393).
- [Verify native iOS](https://github.com/porchday/porchday/actions/runs/42840699230).
- [Verify native macOS](https://github.com/porchday/porchday/actions/runs/42840699232).
- [Post detail browser checks](https://github.com/porchday/porchday/actions/runs/42840699324).

Local full suite passed 1,367 tests (327 environment-dependent skips); final focused cache tests passed 11. Exact-source CI runs the database-backed checks. Chromium/WebKit at phone and desktop widths keep the same visible image through 24 unrelated background writes per case, with diagnostics off/on, and perform no extra image byte GET. The prior implementation fails the idle-image assertion. Matching-parent invalidation, late-result replacement, unknown ownership, access denial, warm authorization, expiry, account change and stable geometry are verified.

Hosted staging and production encrypted-photo warm-scroll/HEAD authorization, draft preservation, safe automatic updates, settings/diagnostic consent, native-shell smoke, routing and deployed asset identity checks passed. Authenticated activation continuity passed with zero failures; all recorded fixture rows were cleaned up. Existing-tab forward and rollback asset checks passed.

The independent production monitor recorded 8 healthy samples over 140013 ms after activation, with zero failures.

The first push CI attempt failed the existing Share-composer DOM-persistence assertion. The unchanged test passed twice locally and the subsequent exact-source CI attempt; the assertion was retained. Its inconsistent first result remains tracked under #3. The initially unassigned iOS job was requeued without changing source or checks and then passed.

The first staging activation observed mixed old/new shell and service-worker asset hashes and was not accepted. The same durable operation was reconciled and rolled back to the reviewed baseline; synthetic fixtures were cleaned. A fresh activation of the same uploaded candidate subsequently passed. Original failed evidence is retained; convergence handling is tracked in #3.

## Remaining verification

Physical iPhone/Mac idle-viewing confirmation remains `needs verification` in #168/#49/#114. Automated native builds/tests are available; no new installer, TestFlight or App Store build is claimed. Legitimate photo/content/access changes and expiry can still require reopening; this fix removes resets caused by unrelated background sharing.
