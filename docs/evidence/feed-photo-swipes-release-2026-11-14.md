# Feed photo swipe release — November 14, 2026

Issue [#235](https://github.com/porchday/porchday/issues/235), implementation [PR #236](https://github.com/porchday/porchday/pull/236). Deployed frontend revision `60ed29b841d1dbf27a454386c71cb1e4700e97e6`; merged as `463332091758d07ff41495308bf453dbca62e404`.

## Behavior

At base zoom, deliberate horizontal swipes move through a post’s photos, then through subsequent photo-containing feed items in displayed/filter order. Reverse swipes move backward. Text-only posts and videos are skipped, further feed pages load on demand, and boundaries do not wrap. Standalone post viewers remain scoped to their post. Previous/next buttons and keyboard arrows provide alternatives; pinch and zoomed-in pan retain their behavior. Closing restores focus.

Media remains encrypted in transit/storage with authenticated reads, signature/proof checks, expiry and access invalidation. Decrypted image URLs are memory-only and revoked on change/close. This release changes frontend assets only; API versions, database schema, recovery keys and reader floors remain unchanged.

## Verification

- Six focused browser tests passed, covering Chromium/WebKit, real touch events, multi-post/page navigation, filtering, cancellation, pinch/pan, boundary behavior, focus, expiry and revoked cache access.
- Workspace typechecks, full CI suite, existing viewer/feed/cache checks, formatting and history secret scans passed.
- Exact-source [web CI](https://github.com/porchday/porchday/actions/runs/43664532401), [iOS simulator CI](https://github.com/porchday/porchday/actions/runs/43664532501), and [macOS CI](https://github.com/porchday/porchday/actions/runs/43664532489) passed.
- Hosted staging and production tests created real encrypted synthetic photo posts and verified touch navigation within/across posts, zoomed pan, reverse/keyboard navigation, focus restoration, and standalone-post boundaries.
- Owned test posts/media/accounts were removed; deleted media reads were denied and first object deletion was confirmed. The existing ten-minute late-upload deletion recheck remains scheduled normally.
- Independent production monitoring passed eight consecutive samples over 140 seconds, covering login/logout, authorized reads, denial and readiness; no monthly availability claim is made.
- Staging final activation: 12 healthy continuity samples; production final activation: 13 healthy samples, zero failures in either final window.

## Active versions

| Component | Version |
| --- | --- |
| Production frontend | `a937bec6-87bd-413e-97c1-2d8855c63028` |
| Staging frontend | `73b056c3-0cd2-413c-aaaa-4a87774ee59e` |
| Production API (unchanged) | `a1d2b557-07e5-4329-9239-90f5ac9a59ab` |
| Staging API (unchanged) | `7f91e2b0-f9b4-447a-a3f7-c3ba780f1020` |

## Retained limitations and failed attempts

The first production rollback-ready attempt lacked completed old-tab browser evidence. Its authenticated continuity samples were healthy, but the original exception’s cause remains unverified. That attempt was rejected, rolled back through the maintained controller, and cleaned up before a fresh operation passed. Follow-up is recorded in [#3](https://github.com/porchday/porchday/issues/3#issuecomment-6887734191); it is not counted as successful acceptance.

The initial staging harness incorrectly expected final object-deletion completion within 90 seconds despite the intentional ten-minute recheck. Its failure is retained; reconciliation confirmed first deletion and cleanup. Production uses the corrected assertion.

Default iOS/macOS persistent WKWebView shells share this implementation without a bridge or signed-binary change. No new signed native binary was distributed. Physical iPhone/iPad/Mac gesture acceptance remains **needs verification**; browser automation and simulator/build tests do not claim that check.
