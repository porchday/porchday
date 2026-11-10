# Photo scrolling runway — November 10, 2026

Implemented and deployed through [PR #219](https://github.com/porchday/porchday/pull/219), tracked in #168. The owner explicitly accepts retaining decrypted local content while logged in.

## Behavior

Previously, leaving a 400px margin discarded the displayed URL, and returning waited for HEAD even when cached. A two-minute, 96-entry/48MiB budget including decoded-pixel estimates could evict large photos after only a few entries. Metadata and pagination also started too late for deep photo prefetch.

- Prefetch photos, post details, album covers and feed pages around six viewport heights before they appear.
- Retain opened JPEG/object URLs until more than twenty viewport heights away. Returning within that range avoids a new media request/decryption.
- Mount full image elements only within two viewport heights, allowing distant display surfaces to release.
- Keep verified decrypted JPEGs in a memory-only FIFO cache: 128MiB, no age or entry-count cutoff; signed content expiry is still enforced. The cache budget excludes nearby displayed surfaces and temporary decoding work.
- Run three speculative jobs with a fourth slot reserved for actual visible work; reprioritize queued work as scrolling moves.
- Preserve JPEGs through ordinary app backgrounding while clearing views and stale pending work; returning views reauthorize. Account/key changes, logout, local access invalidation and signed expiry retain their cleanup. New consumers outside the retained window still perform authenticated HEAD.
- No disk persistence, API payload, video access policy, schema or native bridge change.

This improves expected scrolling rather than guaranteeing no waiting after arbitrarily fast jumps, network stalls, memory pressure, or legitimate access/content changes.

## Live release

Runtime source: `ba428683608ecab289783fa742538c4e2b6c1edc`.

| Environment | Active edge/UI version |
| --- | --- |
| staging | `3806fb2a-a0fa-44b1-a890-692e417ba6b8` |
| production | `028c36cc-6516-4871-b76f-d0fa616f37a6` |

## Validation

Fourteen focused cache/scheduler tests pass, including 80 half-MiB JPEGs with 2400×1600 dimensions reused through simulated ten-minute, one-day and thirty-day intervals without redecoding, FIFO budget/expiry, invalidation races and reserved visible concurrency. Chromium/WebKit at phone and desktop widths verify prefetch five screens away without mounting a distant image, a nearly twenty-screen return with zero media requests, farther warm authorization, diagnostics on/off idle stability, account changes, denial, expiry and stable geometry. Existing photo/calendar/draft browser acceptance, typecheck and web build pass.

Hosted staging and production tests use a real encrypted photo and verify the nearly twenty-screen return makes no media request, farther warm reentry uses HEAD without downloading ciphertext, anonymous HEAD is denied and frame geometry stays stable. Draft/update, routing, hidden-builder navigation and simulated native-shell checks also pass. All recorded synthetic fixtures are cleaned. Retained forward/rollback assets and authenticated activation continuity pass.

- [Verify Porchday](https://github.com/porchday/porchday/actions/runs/42854826115).
- [Secret scan](https://github.com/porchday/porchday/actions/runs/42854826272).
- [Verify native iOS](https://github.com/porchday/porchday/actions/runs/42854826097).
- [Verify native macOS](https://github.com/porchday/porchday/actions/runs/42854826106).

The initial post-activation monitor window FAILED: 2 probes hit request deadlines, including login/monitor-freshness and then all initial requests. Current direct readiness/session/shell reads recovered. A separate recovery window recorded 8 healthy samples over 140017 ms with zero further failures. The original failures are preserved and remain investigated under #55; missing retained operational traces prevent exact causal attribution. This is not a claim of a wholly healthy release window.

Staging preparation retried a failed read-only CI lookup before any activation. The first candidate activation stopped in prepared state before a provider-write intent; all continuity samples were healthy. Fresh read-only state diagnostics passed, the original operation was cancelled through maintained tooling, and owned fixtures were cleaned before a fresh activation of the existing upload. Original evidence is retained under #3. Native jobs were requeued once after waiting without runners; no checks were bypassed.

## Native and remaining verification

Both production native entrypoints use WebShellRoot and receive this shared code; the previous SwiftUI client is debug-only. Exact-source iOS simulator/macOS automated checks passed. No new signed distribution is claimed. Physical iPhone/Mac scrolling smoothness, peak memory, background/resume and memory-pressure measurements remain `needs verification` in #168/#49/#114. Synthetic success is not a claim that the owner/device check was performed.
