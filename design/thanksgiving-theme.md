# Thanksgiving background option

Status: locally implemented and accepted by Bobby through Small Potato on November 10, 2026 at 05:08 UTC. No deployment is recorded or authorized by this acceptance.

## Context

This extends the browser-local Background selector described in `apps/web/README.md` and implemented by `apps/web/src/BackgroundControls.tsx` and `apps/web/src/site-appearance.ts`. It is separate from encrypted member profile themes in [the social network design](social-network-design.md#profile-personalization).

The shared public and signed-in web controls now offer **Autumn, Thanksgiving, Clean, New pattern**, in that order. The store saves an allowlisted preference under `porchday.site-appearance.v1`, applies background color/image variables, restores the choice at startup and synchronizes storage changes between tabs. Autumn remains the default and invalid-input fallback.

## Accepted behavior

**Thanksgiving** appears immediately after **Autumn**, before Clean and New pattern. It uses the existing native-button group, selected `aria-pressed` state and polite status announcement.

Thanksgiving applies a distinct harvest treatment: warm brown background, muted cranberry, pumpkin orange, golden wheat and cream accents. The bundled `apps/web/public/thanksgiving-pattern.svg` provides fixed pumpkin, wheat and cranberry-leaf artwork in a repeating tile. Decoration stays behind existing readable panels; the Porchday mark, typography, navigation and visible focus are preserved. Bobby accepted the implementation and artwork through the attached completion proposal.

The existing appearance store and CSS background variables use a fixed allowlisted `thanksgiving` mode. Only the preference identifier is persisted, never arbitrary SVG, CSS or external URLs. Artwork is trusted local markup without scripts or external resources. The web build includes the bundled asset in the PWA shell cache list; this does not add caching of private social content.

Selection applies immediately, survives reload in the same browser and origin, and synchronizes between tabs through the existing storage-event path. If storage is unavailable, the choice applies for the current page with the existing unsaved-preference announcement. This does not provide account or cross-device synchronization.

Autumn remains the default. Thanksgiving is not selected automatically by date and does not overwrite existing saved choices. Autumn, Clean and New pattern retain their behavior. Member wall customization and native iOS themes remain separate.

## Acceptance requirements

- Thanksgiving appears directly after Autumn wherever the shared Background selector renders.
- Selecting it applies the accepted harvest palette and decoration, with accurate selected state and accessible announcement.
- Reload and cross-tab updates retain the selection; storage failures remain usable and explain that saving failed.
- Existing saved choices, malformed-input fallback and generated-pattern behavior remain compatible.
- Public and signed-in layouts remain readable on desktop and narrow mobile widths, with keyboard access and no selector overflow.
- Relevant appearance tests, web typecheck and web build pass. Browser visual verification remains distinct from automated checks.
- Unrelated edits, including `AGENTS.md`, remain preserved. No infrastructure or account-data changes are required.

## Recorded implementation and verification

The accepted [task record](../tasks/79d82734-69be-458c-ba7c-6a04f620a8a6/task.md) documents the local implementation and these results:

- All 32 focused appearance tests passed, including persistence, restoration, simulated storage synchronization, blocked storage, selector ordering, trusted artwork and strict stored-preference validation. Existing theme regression cases remained covered.
- Web typecheck, web build and `git diff --check` passed. The build reported a bundle-size warning.
- The built Thanksgiving SVG matched the source asset, and the generated service worker included its cache entry.
- The operator independently reported passing automated checks.
- Operator inspection of actual public local-preview pages passed at desktop and 390px mobile widths in light and dark mode: correct order, readable artwork and controls, wrapping without overflow, selected state, announcement and reload persistence.
- Two actual local-preview browser tabs passed synchronization checks for Clean and Thanksgiving. Shift+Tab displayed visible focus on Thanksgiving; Enter selected it and updated the other tab.
- An isolated member-layout fixture rendered the actual `BackgroundControls` and `ColorSchemeControls` components with current built CSS and the `app-layout`, `app-main` and `member-appearance-footer` containers. Desktop and 390px mobile light/dark checks passed for control order, readability, selected state and overflow. New pattern wrapped cleanly.

These are historical results from the accepted task and operator evidence, not checks rerun during design reconciliation. The implementation agent's Chromium launch failed with a sandbox permission error; browser verification was operator-reported.

## Verification limits and remaining work

The member-layout fixture verifies the actual components and layout containers, but does not establish a real authenticated-account or authenticated end-to-end page result. That verification remains unperformed; human acceptance does not convert fixture evidence into authenticated testing.

No accounts were created or accessed, and no production data was accessed. No commits, pushes, deployments or infrastructure changes were made for this request. Production behavior and hosted availability of Thanksgiving are unverified. PWA cache inclusion is recorded build evidence, not evidence of an installed-PWA upgrade test. The bundle-size warning remains recorded without a claimed fix.

The original signed-in layout requirement remains part of the design contract above, with its current evidence limited to the fixture. Any later authenticated or deployment verification must be recorded separately within its authorized scope. No new tasks are created by this reconciliation.

## Tracking and human acceptance

This owner desktop request is outside the builder-chat feature voting gate. The initial design-only request was followed by explicit authorization for local implementation, then operator verification and a completion proposal.

Bobby accepted proposal `43b5631a-23b0-4c43-ac88-4da88162e9b5` through the application on November 10, 2026 at `05:08:35.271Z`, for snapshot `8893ce130987cf74f9b983888fc2640d435214837e514c7278399fcade574c4c`. Acceptance covers the presented local implementation and its disclosed verification limits. It does not authorize deployment. The accepted task document remains unchanged; its statements that sign-off was pending describe its pre-acceptance evidence record.

Tracking: [porchday/porchday issue #211](https://github.com/porchday/porchday/issues/211), P2, supplied by the operator after duplicate checking and creation. This supersedes the initial unpublished issue-creation draft; do not create a duplicate.

The implementation agent could not reach the GitHub API, so its issue update remained unpublished. No remote synchronization, label change or closure is established by this reconciliation. The existing issue should receive the implementation evidence and application acceptance when connectivity and authorization permit, preserving the authenticated-testing and deployment limits rather than claiming those checks passed.
