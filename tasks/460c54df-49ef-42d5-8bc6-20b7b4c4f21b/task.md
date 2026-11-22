## Objective

Validate and prepare the carried-forward Thanksgiving candidate on current Porchday source for Bobby's human review and a later, separately authorized release. Priority: P2, matching [#211](https://github.com/porchday/porchday/issues/211).

## Origin and authorization

Operator desktop request on November 21, 2026, outside builder-chat feature voting. Historical task: [Add Thanksgiving beside Autumn](../79d82734-69be-458c-ba7c-6a04f620a8a6/task.md). Historical intent: [Thanksgiving background](../../design/thanksgiving-theme.md). Integration tracking: [#94](https://github.com/porchday/porchday/issues/94). Do not create duplicate issues.

Bobby initially authorized local automated validation, browser/native assessments, disposable synthetic fixtures, local preview servers and task evidence updates. His November 21 continuation additionally authorizes inspection of host operation evidence and edits to `docs/native-parity.json`, `docs/native-parity.md` and this task's evidence. No implementation changes, commits, pushes, deployments, infrastructure/runtime changes, credential tooling, secrets, CI dispatch or production data are authorized. Report any implementation defect and proposed fix before changing code.

The historical November 10 acceptance of proposal `43b5631a-23b0-4c43-ac88-4da88162e9b5`, snapshot `8893ce130987cf74f9b983888fc2640d435214837e514c7278399fcade574c4c`, does not accept this candidate. Preserve the accepted historical task and unrelated files.

## Scope and acceptance criteria

- Identify the exact tested source plus working patch and asset hashes.
- Thanksgiving appears immediately after Autumn wherever the shared selector is used, with intended artwork, readable panels, usable wrapping and visible focus.
- Verify keyboard activation, selected state, polite announcements, reload persistence, actual cross-tab synchronization, blocked-storage warnings, malformed-input fallback and compatibility with Autumn, Clean and generated patterns.
- Run current-source appearance tests, web typecheck/build and diff checks; record counts and warnings. Verify built SVG integrity and generated service-worker cache inclusion.
- Exercise Chromium and WebKit at desktop and narrow mobile sizes in light/dark appearance. Identify actual public UI, authenticated synthetic UI and fixtures separately; retain missing coverage explicitly.
- Audit both default native shared shells and the restricted appearance bridge, including Thanksgiving's `#493125`, persistence/restoration, blocked browser storage, invalid-color rejection, fallback and privacy cover. Record the legacy Swift interface separately. Compilation alone is not behavior parity.
- Audit current native parity documents without replacing them with stale historical files. Required exact-source iOS simulator/macOS checks must pass or remain explicitly blocked. Exact-source successful push CI remains required before production through maintained release tooling; publication is not authorized here.
- Preserve device/hosted-native follow-ups under #49/#114/#208. These are distinct from automated checks and are not additional web/API production prerequisites. Signing/distribution availability remains separate.
- Review materials distinguish implementation, verification, human acceptance, release authorization, deployment and production verification. Reconcile #211/#94 and ROADMAP only when permitted and reachable.

## Candidate provenance

Workspace: `/Users/bobby/.codex/worktrees/small-potato-porchday/porchday`. HEAD remains `a75106701d356f95b6cba052f4d16f2dd6bab0e9`. Candidate is HEAD plus working-tree changes and the untracked SVG, not HEAD alone.

Before the audit-document edits, SHA-256 of `git diff --binary` was `4dbbc6016f1fe0a6feb49aadc7004b5b2c542170764703a9424ceceb82d9279a`. After those edits, the unchanged web-only diff (`git diff -- apps/web`) retains that hash. Do not describe the old hash as covering the new documentation changes.

SHA-256 implementation identities recorded in the original validation:

| File | SHA-256 |
| --- | --- |
| `apps/web/src/BackgroundControls.tsx` | `5a337af87d05dd79b764c61d10fa13bd6b8f7a5baac4a1dc00a1570b39ccf9db` |
| `apps/web/src/site-appearance.ts` | `00a412477ab23f7f18f49f2805c2b12504a84276faca36d044905e279b33081b` |
| `apps/web/test/site-appearance.test.ts` | `bc45977b2b03329ffea1cc8885fa5e59f7313cd8dd92b731c08fea97c00c3d8d` |
| `apps/web/vite.config.ts` | `2d6478c1fead0894841376cb6f599673169322c8c536bd76ef60688c6455a702` |
| `apps/web/public/thanksgiving-pattern.svg` | `56a788906c40f0589fe08f97b73a0960c2c315ec06508adddf3b2b02a9639549` |

The SVG hash was rechecked unchanged during the audit. Only the two authorized parity documents were edited directly in this continuation. Their resulting hashes are:

- `docs/native-parity.json`: `3331ecb65ebb3805890069eee11e9943f235138c18b54a83af140ef3c9e6069d`
- `docs/native-parity.md`: `7a4cda30e1faeb0ac0d3b16ccae2059897d9c9b752552fdb309669e685c73e6e`

The historical task, shared design files, AGENTS.md and implementation were preserved. Builds from earlier checks generated ignored local output.

## Original sandbox verification

These checks were executed by this task agent in the initial validation turn:

| Command/check | Actual result |
| --- | --- |
| `npx --no-install vitest run apps/web/test/site-appearance.test.ts` | PASS: 1 file, 32 tests, Vitest 5.0.5; duration 107 ms. |
| `npm run typecheck -w @porchday/web` | PASS, exit 0. |
| `npm run build -w @porchday/web` | PASS, exit 0; Vite 7.3.7 transformed 299 modules. |
| `git diff --check` | PASS, no diagnostics. |
| `cmp apps/web/public/thanksgiving-pattern.svg apps/web/dist/thanksgiving-pattern.svg` plus Python byte equality | PASS, identical built artwork. |
| Python ElementTree parsing of SVG | PASS; SVG namespace, 240 × 200, matching viewBox. |
| `rg -n 'thanksgiving-pattern' apps/web/dist/sw.js` plus assertion | PASS; artwork included in generated `SHELL`. This is not offline browser verification. |

Build warnings: `DiagnosticPanels.tsx` is both dynamically imported by `main.tsx` and statically imported by `Settings.tsx`/`vault.tsx`; some minified chunks exceed 500 kB. No fixes were made.

The 32 tests use an injected store environment and static React markup. They cover persistence/restoration, simulated storage events, blocked reads/writes, compatible themes, malformed input and selector markup. They do not independently establish actual browser reloads, real two-tab synchronization, keyboard interaction or screen-reader output.

The sandbox preview attempt `npm run dev -w @porchday/web -- --port 4173` failed with `listen EPERM: operation not permitted 127.0.0.1:4173`. Playwright launch probes also failed before opening pages: Chromium reported MachPortRendezvousServer permission denied (1100), SIGTRAP, plus DNS/power diagnostics; WebKit reported Abort trap 6, exit 134, without an established precise cause. These remain failed sandbox attempts, not retroactive passes.

## Inspected host-side operation evidence

The continuation inspected the authorized shared-context snapshot and operation receipt/captured check output, not agent transcripts or raw session logs. Host operation `25932e22-7487-4113-89a3-2c69ccfe119c` reports `succeeded`, exit 0, from `2026-11-21T23:43:11.168Z` to `2026-11-21T23:43:22.131Z`. Candidate snapshot: `00dc80a4929b5b31933e5f8b19fb763537e9fc5e467064a6bb195c497283f0ad`; binding: `ba64600431d28ad6b854ba2434f4904f1521fa38e89100dcbef82531b4659840`. Receipt output digest: `358068f66877026393fafdde6024c5e977093138e0ccb19a94b3c7c8672af47d`; capture is complete and not truncated.

All 11 configured checks passed:

- `appearance-tests`: captured output confirms 32 tests, 1 file, Vitest 5.0.5, duration 87 ms.
- `web-build`: Vite 7.3.7, 299 modules, reported build duration 1.33 s, with the same mixed-import/large-chunk warnings.
- `bundled-artwork`.
- Chromium: width 1280/light, 1280/dark, 390/light and 390/dark.
- WebKit: width 1280/light, 1280/dark, 390/light and 390/dark.

These were host-run local signed-out browser checks, not this agent's sandbox runs. They predate the new audit-document edits. The receipt does not expose viewport heights, browser versions or per-behavior assertions; do not invent them. Passing named combinations does not independently establish every keyboard/focus, announcement, real cross-tab, blocked-storage or malformed-preference requirement. Authenticated synthetic coverage and native WKWebView interoperability remain unverified by this receipt. No hosted accounts or production acceptance are implied.

Earlier host operations `c6e5545e-1473-46a4-8aa5-6cd7062c9a85` and `829f07a6-9e43-468b-b70a-feb2abd6e1a7` remain failed records. The supplied owner resolutions report tests/build/assets passed but the first browser check failed and later checks did not run. Adapter Vite selection and then `.mjs` MIME handling were corrected outside this task-agent continuation. The successful operation is separate evidence, not a rewrite of those failures.

## Native implementation audit

Conclusion from current-source inspection: no missing Thanksgiving implementation was identified in either default iOS or macOS shell. No native code change is proposed by this audit. Runtime validation remains separate.

Inspected the Thanksgiving diff, `apps/ios/project.yml`, `PorchdayApp.swift`, `WebShell.swift`, `ShellAppearance.swift`, `WebShellTests.swift`, current parity documents, both native workflows and `release-native-parity.ts`.

- Both native app targets include the shared Porchday source directory and default to `WebShellRoot`. Their shared React UI uses the same Background selector and theme mechanism. Thanksgiving is immediately after Autumn and supplies the SVG plus `#493125`.
- The persistent WKWebView uses the browser-local appearance store. The DEBUG-only `--legacy-native-ui-testing` path selects `PreviousNativeApp`; this audit does not claim a Thanksgiving selector in that legacy Swift interface.
- The document-end main-frame observer watches root style/class/background mutations and pageshow, reading the applied CSS color independently of browser storage. Its message contains only version/command/color, not page content.
- The receiver checks trusted HTTPS main-frame/page origin and protocol version. It accepts only `#` plus six ASCII hex digits, normalizes accepted values, rejects invalid values and persists changes in UserDefaults. Initialization restores a valid saved color or Autumn's `#281b13` fallback.
- A Thanksgiving choice applied while browser storage is blocked has an existing path to the native cover. Browser theme persistence and native cover persistence are separate: a reload can restore the browser fallback when saving failed, and that applied fallback can subsequently update the cover. Runtime delivery/restoration under these conditions remains unverified.
- The inactive cover is opaque color plus the Porchday label, not a screenshot. Its foreground formula selects white for Thanksgiving; the earlier independent contrast calculation was approximately 12.00:1. This is source/numerical evidence, not device acceptance.
- `testSwitcherAppearanceValidatesAndRestoresOnlyOpaqueColors` is included in both test targets and covers generic validation/restoration/fallback. It was not executed here and is not a Thanksgiving end-to-end bridge test.

The addition requires no new native bridge, permissions or signing behavior identified by this source audit. Installed versions must already contain the existing appearance bridge; no claim is made about new signed builds, distribution or installed-version verification.

## Native execution limitations

Original `xcodebuild -version` failed because the active developer directory is `/Library/Developer/CommandLineTools`; `xcrun simctl list devices available` failed because simctl was unavailable.

Original explicit attempts:

- `xcodebuild -project apps/ios/Porchday.xcodeproj -scheme Porchday -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/porchday-thanksgiving-ios CODE_SIGNING_ALLOWED=NO build`
- `xcodebuild -project apps/ios/Porchday.xcodeproj -scheme PorchdayMac -destination 'platform=macOS' -derivedDataPath /tmp/porchday-thanksgiving-macos CODE_SIGNING_ALLOWED=NO test`

Both failed immediately with the Xcode developer-directory error. No native build or test executed. iOS tests also require an available simulator destination. This documentation-only continuation did not retry them or dispatch CI. Exact-source successful native CI remains unknown/unverified, not passed. Device and hosted-native acceptance remain pending under #49/#114/#208.

## Parity documentation changes and verification

Added `Thanksgiving candidate audit — November 21` to `docs/native-parity.md` and linked it from the navigation evidence array in `docs/native-parity.json`. The audit distinguishes implemented source from runtime checks, host receipts from sandbox attempts, and source/build availability from signed distribution. All existing implementation and platform acceptance statuses and follow-up issue links remain unchanged.

Executed documentation checks:

- Python JSON parsing and comparison against HEAD: PASS. Exactly one navigation evidence link was added; all other rows, statuses and values were preserved.
- Python Markdown prefix comparison against HEAD: PASS. Existing Markdown was preserved and the audit appended.
- `git diff --check`: PASS.
- Web diff and SVG hashes: unchanged.

No application tests or native tests were newly run during this audit-only continuation. These documentation checks do not establish release readiness.

## Remaining work and later-release checklist

1. Obtain detailed browser assertion evidence for keyboard/focus, announcements, reload persistence, real two-tab synchronization, blocked storage, malformed preferences and theme compatibility; fill any uncovered checks. Complete or explicitly retain authenticated synthetic coverage limitations. Do not infer these from the host receipt's check names.
2. Run the required exact-candidate iOS simulator/macOS checks with full Xcode and complete the Thanksgiving runtime appearance-bridge assessment. Preserve actual failed/skipped results and device follow-ups.
3. Obtain separate authorization to publish the complete candidate, including SVG and audit documents, as a commit to `porchday/porchday`. The maintained `.github/workflows/ios.yml` and `.github/workflows/macos.yml` run on every push. No publication or CI dispatch is authorized now.
4. Record successful exact-source push run IDs, attempts, jobs and required steps. iOS requires cryptographic interoperability, simulator tests and launch/evidence capture; macOS requires compile, contract tests and artifact packaging. `verifyProductionNativeParity` reads the matrix from that commit and checks exact SHA/repository/event/job/step identity. A dispatch run, PR merge run, prior/base commit or local compile is insufficient. Any subsequent source change requires matching evidence again.
5. Reconcile #211/#94 and the ROADMAP discrepancy through project chat when authorized and reachable. ROADMAP lists #94 as a proposal and lacks #211; no remote reconciliation or issue update occurred here. No duplicate issue was created.
6. Obtain human review and separate release authorization; satisfy ordinary staging, continuity, schema and rollback gates and use maintained activation tooling with native parity enforcement intact. Hosted-native interoperability and physical devices remain distinct follow-ups, not additional web/API production prerequisites. Native distribution retains its own signing/device requirements.

## Implementation and human acceptance

The source audit is documented and host-side configured checks are now evidenced. Required native checks and remaining behavioral evidence are still missing. No implementation defect was confirmed, and no implementation code was changed. The task remains active; no completion proposal is made.

Bobby has not accepted this candidate. Human sign-off is an application action. No commit, push, CI dispatch, hosted account creation, credential tooling, production-data access, runtime configuration change, deployment or live-service verification occurred in this continuation. Historical acceptance and release records remain provenance only.