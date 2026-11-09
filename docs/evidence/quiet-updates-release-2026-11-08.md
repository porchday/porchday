# Quiet automatic web UI updates

Released November 8, 2026. [PR #191](https://github.com/porchday/porchday/pull/191), [issue #190](https://github.com/porchday/porchday/issues/190). [Design](../../design/automatic-updates.md).

The PWA, browser and default native web shells silently check the public application shell for a new build. Updates apply automatically after a minute of inactivity or while backgrounded, only when no save/upload, unsaved edit, focused editor, open dialog or media playback needs protection. Saved encrypted Share drafts restore after the reload. Unsubmitted form edits defer until their controls leave the page. No Update now button or update-available banner remains. Public-shell checks work without a service worker; polling failures are silent and later checks retry. Session-local throttling prevents rapid reload loops during deployment propagation.

A waiting service worker asks every open window whether it is safe to activate. Busy or unresponsive windows defer activation. Existing older clients without the safety protocol adopt the behavior when they next load the updated UI; they are not forcibly reloaded with unknown unsaved work.

Normal background access-sharing progress no longer displays a notice. Failures explain the access limitation and offer retry. Offline/outage, failed operations, storage errors and blocking-save feedback remain. Existing opt-in social notifications are unchanged.

This release changes only the shared frontend. Environment-specific APIs, database schema and native bridges are unchanged. iOS 247 and macOS 255 remain the available native builds. Native binary installation still follows TestFlight/App Store and OS/user settings; this web release does not claim to force-install a new binary.

## Verification

- Web typecheck/build and all 338 web tests passed. Chromium/WebKit checked silent idle updates and deferral for unsaved drafts, pending writes, unsubmitted inputs, dialogs, playback and offline state; unchanged builds do not reload.
- Service-worker tests verified all-window readiness, rejection by a busy window and timeout of an unresponsive window. Existing Chromium/WebKit feed-save and navigation regressions passed.
- Exact-source web, secret-scan, iOS simulator and macOS CI passed. The maintained native-parity production gate was enforced.
- Deployed staging/production checks used synthetic accounts and a public-shell response announcing a test build. An unsaved-work guard prevented reload; removing it at a safe background point triggered an actual automatic page reload, with no button. The encrypted draft, photo and original date restored. Publication and explicit discard still cleared saved drafts; all fixture accounts/content were removed.
- Authenticated continuity, revocation, canonical routes, native-shell bridge, asset hashes and forward/rollback open-tab compatibility passed. Local release assets were rebuilt with the pinned workspace Vite version before upload; the rejected local root-bundler build was never deployed.

Physical OS lifecycle/foreground acceptance remains follow-up in #49/#114; hosted browsers and simulators are not physical-device verification.

Exact-source checks: [web](https://github.com/porchday/porchday/actions/runs/42537730070), [PR](https://github.com/porchday/porchday/actions/runs/42537733267), [iOS](https://github.com/porchday/porchday/actions/runs/42537730200), [macOS](https://github.com/porchday/porchday/actions/runs/42537730081).

## Deployed versions

| Environment | Component | Source | Version |
| --- | --- | --- | --- |
| staging | API (unchanged) | `5d327fd0f430787904516a31dc8623abc2943096` | `2427e972-e02e-47f2-9933-ee524b546863` |
| staging | Frontend | `19ac2fdf596cbf1076154b08047043d9f2310e73` | `5bb16eb8-28ab-4217-88a7-5c30d8e85b9c` |
| production | API (unchanged) | `822a4c4d1f650cdfde0051094b2cc73bb0c721dc` | `b34440db-f806-44e1-8298-34f9c7ea5cef` |
| production | Frontend | `19ac2fdf596cbf1076154b08047043d9f2310e73` | `fe045b7d-d028-44c7-a54a-012d563f9218` |

Final audit passed at `2026-11-09T00:19:57.373Z`. Production monitoring observed 8 samples over 140014 ms with zero failures. Provider state matched the canonical deployment record, unchanged schema fingerprints were verified, and fixture checks returned zero remaining rows.
