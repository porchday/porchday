# Composer and post feedback — November 9, 2026

[PR #206](https://github.com/porchday/porchday/pull/206) is merged and deployed to staging and production. Tracks #205 and #207.

## Behavior

Share, the smaller Discard draft action and draft status are in the bottom composer footer, after media and audience controls. Video/storage guidance starts collapsed; the attachment heading reads as a smaller subsection. Mobile and desktop layouts preserve useful touch targets and wrap without horizontal overflow. Draft restore/save retry controls stay outside the disabled fieldset.

After server-confirmed post creation, Share opens Feed and renders the author's confirmed row and content from account-scoped memory immediately, without waiting for a feed read or decryption round trip. The server row reconciles without duplication. State is cleared on logout and respects expiry. Failed publication stays in Share with the draft intact. Existing group/wall composers keep their own refresh behavior.

After confirmed deletion, the old UI previously left the post visible until a separate feed refresh completed. It now shows Deleting post immediately, suppresses repeat submission, and replaces content with Post deleted after confirmation. Failed deletion restores content with a visible retryable error. A failed parent refresh cannot resurrect the deleted post or report deletion failure. State is scoped to the post identity.

## Release and validation

- Shared UI source: `2b689210da6ae630dbf56b39443f242c34d5df0f`.
- Staging UI Worker: `b4d504af-3498-44e1-922d-c2f2c123fbd5`.
- Production UI Worker: `35ce726f-d21a-44f5-bd3d-ec3a42a95ddc`.
- Backends and schema are unchanged from the preceding [clickable-links release](clickable-post-links-release-2026-11-09.md).
- Maintained activation tooling retains exact-source native parity, asset hashes, old-tab/fresh-client checks, authenticated continuity and automatic rollback.
- Workspace typechecks and local Chromium/WebKit tests pass: deletion cancellation, delayed response, failed deletion/retry, stale or failed refresh, identity reuse, failed publication and encrypted draft preservation, immediate confirmed Feed rendering with the feed response held, and deduplication after reconciliation.
- Mobile/desktop visual checks verified footer placement, smaller Discard, expandable storage guidance and no horizontal overflow.
- Exact-source push CI: Verify Porchday 42679485882, Secret scan 42679485539, iOS 42679485875, macOS 42679486169 and post-detail browser checks 42679485517 passed.
- Hosted staging and production confirmed footer geometry at phone/desktop widths; published an encrypted Only me post while the feed request was held; observed the post immediately and exactly once after reconciliation; exercised synthetic failed deletion and a delayed successful retry; and verified actual deletion in the database.
- Existing clickable links, draft restoration, quiet automatic updates, settings, consented diagnostics, native shell routing and legacy redirects passed hosted checks.
- Production monitoring did **not** achieve a wholly healthy post-activation window: 2 of 12 observations over 220024 ms hit the existing shared-journey logout/revocation deadline. At 19:31:47.882 UTC logout exhausted the remaining deadline; at 19:33:47.896 UTC logout returned 200 but the following revocation observation timed out. Login, feed, profile and readiness passed in both cycles. Subsequent cycles passed including revoked-cookie 401. Failed observations and both unsuccessful monitor acceptance attempts are retained; the existing investigation remains open in #55. No backend/auth/schema changes were part of this UI release.
- Final provider inventory matches the canonical verified deployment; no active lease remains and synthetic fixtures are cleaned up. Feature acceptance is verified separately from the unresolved monitoring warning.

An initial Linux WebKit test run reported canceled background requests when the fixture navigated again after a fixed 300 ms delay. The test now waits for actual network settling before the next recovery navigation, while retaining the assertion that the post is visible before the held feed response. The final CI run passed; errors were not suppressed.

The initial hosted staging check passed feature assertions but its cleanup attempted to delete an already-deleted synthetic post a second time. Its evidence was preserved, fixtures were reconciled, and a corrected fresh run verified cleanup successfully. The first production rollback-ready attempt stopped before activation intent; existing service continuity stayed healthy. The maintained CLI canceled it, 20 healthy samples and scoped fixture cleanup verified the baseline, and a new reviewed activation passed. A read-only authorization replay passed in 4.291 seconds, but the original suppressed exception remains unproven and is tracked under #3.

No new native bridge or signed binary is required. Existing thin-shell iOS/macOS apps receive this shared UI update. Physical iPhone/macOS interaction acceptance remains explicitly unperformed and tracked in #205/#207.
