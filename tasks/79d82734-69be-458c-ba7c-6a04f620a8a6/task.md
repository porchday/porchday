# Add Thanksgiving beside Autumn

Priority: P2

## Objective

Add a Thanksgiving option immediately after Autumn in the existing web Background selector, using the current browser-local appearance mechanism. This is an owner-requested enhancement, not a confirmed defect.

## Design references

- [Thanksgiving background design](../../design/thanksgiving-theme.md)
- [Social network design — profile personalization](../../design/social-network-design.md#profile-personalization)
- `apps/web/README.md`: browser-local backgrounds are separate from encrypted profile themes.
- `apps/web/src/BackgroundControls.tsx`, `apps/web/src/site-appearance.ts`, and `apps/web/src/retro.css`: selector, persistence and rendering.
- `apps/web/test/site-appearance.test.ts`: regression coverage.

## Scope

- Add Thanksgiving between Autumn and Clean in the shared Background controls used by public and signed-in layouts.
- Extend the allowlisted appearance mode, parser, selection handling, styling and announcement using the existing storage key and background variables.
- Provide a trusted local repeating harvest treatment using warm brown, muted cranberry, pumpkin orange, wheat gold and cream, with restrained seasonal motifs. Keep existing panels readable.
- Preserve Autumn's default/fallback behavior, Clean, generated patterns, stored preferences, storage-failure handling and cross-tab synchronization.
- Add focused regression coverage and inspect desktop/mobile public and signed-in layouts.
- Preserve unrelated edits, especially the existing `AGENTS.md` modification.

The owner authorized local implementation after the design turn. No native iOS theme changes, encrypted profile changes, automatic seasonal switching, infrastructure changes or deployment are included. Do not create accounts, access production data or secrets, commit, push, deploy, or edit design documents for this request.

## Acceptance criteria

- Thanksgiving appears immediately next to Autumn, in the order Autumn, Thanksgiving, Clean, New pattern, wherever the shared selector renders.
- Selecting Thanksgiving immediately applies a coherent, visually distinct Thanksgiving palette and decorative treatment through the current mechanism.
- The selected button has accurate `aria-pressed` state and a polite announcement; keyboard navigation and mobile wrapping remain usable.
- The selection survives reload in the same browser/origin and updates another open tab through the existing storage-event path.
- Blocked storage still allows selection and reports that the preference could not be saved.
- Existing themes and saved preferences remain usable; malformed input still falls back safely; no arbitrary stored markup or external artwork URLs are accepted.
- Focused appearance tests pass, including ordering, persistence, synchronization and regression cases. Run `npx vitest run apps/web/test/site-appearance.test.ts`, `npm run typecheck -w @porchday/web` and `npm run build -w @porchday/web`; record results and any additional required project checks.
- Record visual verification on desktop and narrow mobile layouts for public and signed-in pages, including readability and visible focus.
- Completion awaits Bobby's explicit human sign-off. Do not mark this task done automatically or treat passing tests as sign-off.

## Implementation evidence

Local edits add the Thanksgiving button immediately after Autumn in `BackgroundControls.tsx`, and extend the existing appearance store with the fixed `thanksgiving` mode. The same storage key, strict parser, CSS variables, storage-failure announcement and synchronization path are retained. Autumn remains the default and invalid-input fallback.

`apps/web/public/thanksgiving-pattern.svg` supplies fixed local pumpkin, wheat and cranberry-leaf artwork on a warm brown background with gold and cream accents. The web build includes it in the PWA shell cache list. Existing panel styling and member profile themes are unchanged.

Focused regression coverage includes Thanksgiving persistence, restoration, simulated cross-tab synchronization, blocked storage, selector ordering, trusted artwork and rejection of extra stored fields. Existing theme regression cases remain covered.

Unrelated `AGENTS.md` edits were preserved. No accounts were created or accessed and no production data was accessed. No commits, pushes, deployments or infrastructure changes were made. The recovery and evidence-update requests did not replay implementation.

## Verification results

Agent-run local checks passed:

- `npx vitest run apps/web/test/site-appearance.test.ts`: 32 tests passed.
- `npm run typecheck -w @porchday/web`: passed.
- `npm run build -w @porchday/web`: passed, with a bundle-size warning.
- `git diff --check`: passed.
- Built Thanksgiving SVG matched the source asset, and the generated service worker included its cache entry.

The operator independently reported the same 32 focused tests, web typecheck, web build and diff check passing in the recovery message on November 10, 2026. These checks were not rerun for this evidence-only update.

The agent's Chromium launch failed with a sandbox permission error; no agent browser verification is claimed.

Operator-reported public actual-page local-preview inspection covered desktop and 390px mobile widths in light and dark mode. Thanksgiving appeared directly after Autumn; the pumpkin/wheat/cranberry-leaf artwork remained readable; controls wrapped without overflow; selected state and announcement worked; reload retained Thanksgiving.

Additional operator browser evidence on November 10, 2026 confirmed keyboard and cross-tab behavior using two actual local-preview tabs:

- Selecting Clean in one tab updated the other tab to Clean with the storage-sync announcement.
- Shift+Tab moved focus from Clean to Thanksgiving and displayed a visible focus ring.
- Enter selected Thanksgiving, and the other tab updated to Thanksgiving.

Final operator visual evidence used an isolated local member-layout fixture rendering the actual `BackgroundControls` and `ColorSchemeControls` components with the current built application CSS and the `app-layout`, `app-main` and `member-appearance-footer` containers. Desktop and 390px mobile screenshots in light and dark mode showed correct control order, readable controls, accurate selected state and no horizontal overflow. New pattern wrapped cleanly.

The final check verifies the member-layout containers and actual components. It is not a real authenticated-account test, an authenticated end-to-end page test or a production-data test. No accounts were created or accessed. Browser results are operator-reported evidence, not agent-observed results or human acceptance.

## Review and remaining limitations

The supplied public-page, keyboard, cross-tab and member-layout fixture evidence supports presenting the local implementation for owner review. The member-layout visual check was performed through a fixture; real authenticated-account and production behavior remain untested. Production has not been deployed, and the build retains a bundle-size warning.

A completion proposal requests Bobby's explicit human sign-off. No human acceptance has occurred, and this task is not marked done. Final artwork acceptance remains with Bobby.

## GitHub tracking

Tracking: [porchday/porchday issue #211](https://github.com/porchday/porchday/issues/211), P2, supplied by the operator after duplicate checking and issue creation. This supersedes the earlier unpublished issue-creation draft; do not create a duplicate.

The agent's attempt to read issue #211 failed because `api.github.com` was unreachable. No remote issue update or label change by this agent is claimed.

Unpublished issue-update draft: Local Thanksgiving implementation adds the shared selector option, allowlisted persistence mode, bundled harvest artwork and PWA cache inclusion. All 32 focused appearance tests, web typecheck, web build and diff check pass. The operator verified the public actual-page preview at desktop and 390px mobile widths in light/dark mode, including ordering, readability, wrapping, selected state, announcement and reload persistence. Two actual local-preview tabs passed synchronization checks, and Shift+Tab/Enter verified visible focus and keyboard selection. An isolated member-layout fixture rendering the actual BackgroundControls and ColorSchemeControls with current built CSS and app-layout/app-main/member-appearance-footer containers passed desktop and 390px light/dark visual checks, including clean wrapping and no horizontal overflow. This fixture is not a real authenticated-account or production-data test. Implementation is presented for owner review; human sign-off remains pending. Retain the issue open. No commit or deployment exists for this request.

## Open questions

No blocking implementation questions. Bobby's final visual acceptance and explicit human sign-off remain outstanding.
