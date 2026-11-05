# Photo viewer and action-row release — November 4, 2026

Implemented in PR #155, with caption contrast correction in PR #156. Tracking: [#151](https://github.com/porchday/porchday/issues/151).

Production serves source `33e71cfafbbbaf33cb969288c74cbe099a933d19` through frontend `887ebb85-537e-4143-acf0-0b776fce8ddb`. Staging verified the same source through `08901ab0-fb32-4e05-b41d-89b15e1419df`. API versions are unchanged: production `22920571-07b6-4192-b44e-f2ae87333d3c`, staging `336f75f1-2a64-4f0f-b8e9-949fc1fa30ff`. No database migration or audience-policy change was needed.

## Behavior

Standalone photos show reaction chips and a separate Comment action, using the shared legacy/Unicode/custom emoji picker. The Photo badge is removed. Post attachments and standalone photos open a clean zoomable viewer with close, reset, pinch/wheel zoom and dragging. Keyboard access includes Enter/Space to open and Escape to close with focus restoration. The viewer reuses validated decrypted media and disappears when its source expires or unmounts. Caption contrast is explicitly protected from theme overrides.

Shared iOS/macOS source includes matching photo actions, full emoji picker, and a focused viewer with zoom/reset, magnification and drag controls. This web/API rollout did not distribute a signed native installer, TestFlight build or App Store build. Physical-device gesture and distribution checks remain tracked under #49/#114, not marked passed.

## Validation

- The exact-source Verify Porchday workflow and secret scan passed. Native iOS simulator and macOS build/tests passed: [.github/workflows/ios.yml](https://github.com/porchday/porchday/actions/runs/41976396271), [.github/workflows/macos.yml](https://github.com/porchday/porchday/actions/runs/41976396243).
- Local tests: 1,260 passed and 301 environment-dependent tests skipped; crypto tests: 25 passed. Required database integration tests ran in CI.
- Browser checks at 320, 390 and 1200 pixels cover failed-save retry, reaction replacement/removal, Unicode selection, comment deletion, expiry, zoom/pan/wheel/pinch/reset, keyboard close and focus restoration. Viewer tests load the actual theme and assert caption color.
- Hosted staging and production checks verified encrypted photo comment submission and owner decryption, reaction replacement/removal, comment deletion, removal of the badge, clean viewers from post attachments and feed photos, readable captions, and album revocation denying conversation access. Synthetic fixtures were cleaned up.
- Old-tab and rollback asset compatibility, login/route/PWA checks, schema fingerprints and provider inventory passed. Production activation recorded 16 continuity samples with zero failures. The independent production monitor observed 8 healthy samples over 140 seconds with no failures.

Release used vetted tooling commit 239292e225aaec8c655903ba40b1e63469dea633, including the complete deployed queue inventory and exact-source native parity enforcement. Consolidating that reader into main remains tracked in #3. Private evidence and synthetic credentials are excluded from this document.

One staging attempt exceeded a five-second UI assertion while a reaction save remained in progress. Readback confirmed the intended reaction committed; the fixtures were cleaned up. The final checks explicitly awaited the server response and confirmed UI state, and passed on staging and production. The failed attempt and reconciliation remain in private evidence.
