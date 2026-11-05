# Unified activity header release — November 4, 2026

Implemented in PR #158 with alignment correction in PR #159. Tracks the feed-header portion of [#28](https://github.com/porchday/porchday/issues/28); its wider avatar and device acceptance remains open.

Production serves source `88e597efb1d5eb963a1b285c2ea6a12a3b80b30d` through frontend `d7d421d8-d2ff-422e-9543-64513c161efc`. Staging verified the same source through `0f2487fc-5371-4a4f-b346-8bc2496d982d`. API versions are unchanged: production `22920571-07b6-4192-b44e-f2ae87333d3c`, staging `336f75f1-2a64-4f0f-b8e9-949fc1fa30ff`. No schema or audience-policy changes.

## Behavior

Photo and post cards reuse the same author header: authorized avatar, linked handle on web, and a compact date/lock line inside the card. Photos retain their editable photo date; posts retain publication time. Standalone photos say “Shared photo” rather than implying that one visible grant describes every audience or album with access. Attachment-only photo entries retain the post audience. The duplicate date beneath feed photos is removed; album cards keep their existing layout.

Shared iOS/macOS source uses the same avatar/author/date hierarchy. Exact-source native build/tests passed. This frontend release does not distribute signed native binaries; device and distribution follow-ups remain under #49/#114.

## Validation

- Exact-source web verification, secret scan and native iOS/macOS CI passed. Native evidence: [.github/workflows/ios.yml](https://github.com/porchday/porchday/actions/runs/41983337608), [.github/workflows/macos.yml](https://github.com/porchday/porchday/actions/runs/41983337361).
- Local production build and post-detail, photo-interaction, and unified-feed browser checks passed.
- Hosted staging and production assertions verified equal avatar dimensions, typography and card insets for photo/post headers at mobile and desktop widths, linked photo authors, and a single photo date inside each feed card. Screenshots were reviewed.
- Existing encrypted comment, reaction, photo-viewer, audience/revocation, album, filter, calendar, root-route, legacy-domain and PWA flows passed. Synthetic accounts and content were cleaned up.
- Old-tab and rollback assets, provider inventory, schema fingerprints and session continuity passed. Production activation observed 16 samples with 0 failures. Independent monitoring recorded 8 healthy samples over 140 seconds.

The first staged comparison found a small vertical offset caused by the post menu touch target. Its synthetic fixtures were reconciled and removed. The shared header now has a 44px minimum height; the final staged and production comparisons passed. The failed attempt remains in private evidence.

Release tooling: `239292e225aaec8c655903ba40b1e63469dea633`, including the complete deployed queue inventory and native parity enforcement. Consolidating the reader remains tracked in #3. Private release proofs and synthetic credentials are not included here.
