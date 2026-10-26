# Hosted native interoperability verification

The manual `Verify hosted native interoperability` workflow exercises one synthetic staging scenario using the shipped Swift `AppModel`, `API`, `CryptoVault`, native GopenPGP bridge, image decoder and Keychain code. It is separate from the ordinary offline/simulator workflow. Preparing this test is not evidence that staging has been exercised; record the actual run and the independent web-side result after execution.

## Scope

The web smoke runner creates verified synthetic accounts, mutually connects A and C, enrolls their browser keys, and publishes A's encrypted synthetic post and 16 × 16 JPEG. The iOS test then:

1. Signs in as C with the real email/password endpoint and checks the expected member identity.
2. Opens C's encrypted recovery backup with the independent recovery secret, recovers historical keys and authorizes a fresh native device through the existing recovery challenge/signature flow.
3. Fetches A's hosted post/photo, verifies their signatures and recipient/context bindings through `CryptoVault`, decrypts them, checks exact synthetic text and JPEG SHA-256, and decodes the JPEG with the shipped bounded image decoder.
4. Encrypts/signs new native post/photo envelopes for the current connections audience using the newly enrolled native key, preserving the fixture's two-hour deadline and the exact JPEG bytes. It reserves/uploads the photo and publishes through the real HTTP API, then reads/decrypts the stored native content again.
5. Signs out through the real endpoint, clears local test keys/session and confirms the session no longer identifies a member.

After the simulator succeeds, `scripts/hosted-smoke.ts interop-check --run` signs in as A and uses OpenPGP.js to verify/decrypt the native post/photo from staging. It requires the new native author device and exact text/photo/deadline. Both results are needed to claim web↔native hosted interoperability. The fixture is deliberately small; this test is not a maximum-size, push, universal-link, performance, physical-iPhone or independent security audit.

The test uses normal server authentication, invitations/email verification, device authorization, audience selection and content routes. It contains no privileged session injection, verification-token extraction, test-only server route, or auth bypass. The initial fixture account has no second factor enabled; a two-factor redirect fails this scenario rather than bypassing it. MFA is covered separately.

## Fixed origin and isolated storage

Current release builds use `https://porchday.org`; the historical runs below predate the [domain migration](domain-migration.md), and existing `.com` clients retain their compatibility API. Only a DEBUG build with the explicit runtime flag `PORCHDAY_HOSTED_STAGING_TEST=1` uses the fixed `https://staging.porchday.com` origin. The flag cannot supply an arbitrary URL. Both requests and redirects enforce the selected HTTPS origin, including port and absence of embedded credentials. Hosted debug tests use a separate Keychain service, `com.porchday.app.keys.hosted-staging-test`, to avoid reading or clearing production app credentials. The API's cache and cookie protections remain unchanged.

The normal simulator suite skips the opt-in hosted test. A skip does not count as hosted success. The dedicated runner checks the actual XCTest result tree for exactly one successful `testHostedInteroperability` method, no failed/skipped tests, and a test count of one.

## Private fixture handoff and manual execution

Do not run until the operator confirms staging is ready, the three delivered verification emails have been handled through the normal owner flow, and the synthetic social smoke has passed. The existing web runner's `interop-prepare --run` phase then writes `artifacts/private/hosted-smoke/native-interop.json` with mode `0600`. It contains a v1 synthetic marker, the staging origin, a run identifier, two-hour expiry, C's synthetic login/recovery secret, expected web post/photo IDs and contents/checksum, and preallocated native post/photo IDs. It contains no real member data. Do not print it, attach it to chat, or commit it.

The operator supplies its exact UTF-8 JSON encoded as standard base64 to the dedicated, temporary GitHub Actions repository secret `PORCHDAY_IOS_HOSTED_FIXTURE_B64`. Base64 is transport encoding, not encryption. Use the GitHub CLI/API's protected stdin/structured input; never put the value in a shell argument, workflow input, command echo, or file tracked by Git. This grants the ephemeral GitHub-hosted runner access to these synthetic credentials only. Repository visibility does not make workflow logs private. Do not give this workflow deployment tokens, database credentials or any other account's recovery secret.

Dispatch `.github/workflows/ios-hosted.yml` on `main` with `confirm_staging_only=true`. The workflow has read-only repository permissions, a 35-minute limit, no automatic push trigger and no artifact upload step. The runner validates the fixture before any simulator/network work and again after the build. Expired or malformed fixtures fail closed. Run one approved fixture at a time; regenerating or retrying after partial native writes requires a fresh coordinated fixture or explicit cleanup, because native enrollment and publication are real operations.

Delete the temporary GitHub secret immediately after the run finishes, fails or is cancelled; the workflow intentionally does not receive repository-admin credentials that could delete its own secret. The operator owns this cleanup even if the runner is interrupted. Then run the independent web checker before cleaning up the synthetic accounts through the established smoke cleanup. Do not claim completion from native success alone or delete the native content before the web checker has read it.

## Output handling

`scripts/run-hosted-ios.ts` is restricted to an ephemeral macOS GitHub Actions runner and requires `--run`. It creates a new owned simulator, captures raw build/test output under a mode-0700 directory outside the repository in `RUNNER_TEMP`, and writes a mode-0600 generated `.xctestrun` with the synthetic runtime environment for the selected unit-test target only. The fixture is not compiled into the app or copied into the repository. The wrapper removes the secret from child build environments and passes it only through that private test-runtime manifest.

The XCTest replaces every fixture/network/crypto error with a fixed phase label. The outer runner emits only fixed success/failure codes and cleanup status. Raw logs, `.xcresult`, generated test manifests, screenshots and app bundles are never uploaded by this workflow. On normal completion or handled failure it deletes the owned simulator and private directory. Runner cancellation/termination may prevent the `finally` block; the GitHub runner VM is ephemeral, and the operator must still remove the repository secret. The result is not sufficient if cleanup fails.

Local helper tests cover fixture expiry/origin/shape, safe error handling, targeted runtime-manifest injection and rejection of skipped/native-missing result trees. Swift syntax can be checked locally without claiming a simulator run. The hosted build uses full Xcode on the macOS runner; no App Store account is required.

Apple documents the supported [build-for-testing/test-without-building flow](https://developer.apple.com/library/archive/technotes/tn2339/_index.html) and [running one test and interpreting result bundles](https://developer.apple.com/documentation/xcode/running-tests-and-interpreting-results). The harness uses the installed tool's machine-readable result data; it never treats a build-only success or a skipped test as a completed hosted verification.

## Simulator Keychain prerequisite

The simulator build uses an ad-hoc signature with an app-local `application-identifier` and `keychain-access-groups` entitlement. These settings apply only to `iphonesimulator`; they contain no Apple team identifier and do not enable APNs or Universal Links. The application still uses the shipped device-only Keychain implementation. The normal native suite must pass its real `SecureStoreTests` write/read/update/delete and accessibility checks before running a hosted fixture. Apple describes the relationship between app entitlements and Keychain access in [errSecMissingEntitlement](https://developer.apple.com/documentation/security/errsecmissingentitlement).

The initial hosted attempt (40213370898) stopped at LOGIN; the bounded diagnostic retry (40213888423) identified KEYCHAIN_WRITE. Both removed their private test output and temporary repository secret. Inspection of the earlier ordinary simulator artifact showed no app entitlements under the prior CODE_SIGNING_ALLOWED=NO override. Those attempts did not verify hosted interoperability and reached no native recovery enrollment or content publication. Record subsequent verification separately.

## Verified staging run — October 25, 2026

The final hosted simulator run and independent JavaScript check both passed. The repository was private at this checkpoint; these links record CI evidence, not a public app release.

| Check | Revision / run | Result |
| --- | --- | --- |
| Ordinary simulator suite, including the real Keychain round-trip and device-only accessibility check | `3552fce`, [40214444339](https://github.com/bobbyhwilder/porchday/actions/runs/40214444339) | Passed; the Keychain test executed and was not skipped. |
| Hosted native interoperability against `https://staging.porchday.com` | `cd1335d`, [40214835293](https://github.com/bobbyhwilder/porchday/actions/runs/40214835293) | Passed; the result parser confirmed exactly one successful hosted XCTest, no skipped/failed tests, and private runner cleanup. |
| Independent OpenPGP.js verification using `scripts/hosted-smoke.ts interop-check --run` | Same synthetic fixture, after the native run | Exited 0; `native-post-and-photo-decrypted-by-web-crypto` and final `passed:true`. |

The native run used the real login endpoint and shipped URLSession/Keychain code, recovered historical keys from C's encrypted backup, authorized a fresh native device through the normal signed challenge, and verified/decrypted A's post and 16 × 16 JPEG. It signed/encrypted and published a new native post/photo through the actual staging API, read them back, and signed out.

The independent JavaScript check signed in as A through the normal endpoint and asserted the native author was C; its device was fresh, non-revoked and different from C's original browser device; post/media IDs, parent linkage and the original two-hour deadline matched; OpenPGP signatures and recipient decryption succeeded; and the exact synthetic text and JPEG SHA-256 matched. It then signed out. It did not create a replacement fixture or use native plaintext as its verification result.

Each of the three hosted attempts removed its temporary `PORCHDAY_IOS_HOSTED_FIXTURE_B64` repository secret. After the successful attempt, a separate repository-secret listing confirmed that secret was absent. The native runner reported private simulator/log/manifest/result cleanup. No raw hosted log, `.xcresult`, screenshot, app bundle, private key, recovery secret or login credential was uploaded as an artifact. The synthetic accounts and hosted fixture were retained for the separate restore/browser checks; the fixture's signed deadline remains in force.

This proves the exercised hosted web↔native encryption and recovery flow, not a physical-iPhone test, a browser UI journey, maximum-size native media handling, push delivery, Universal Links, a capacity benchmark or an independent cryptographic audit. The earlier LOGIN failures remain part of the evidence above and were resolved by simulator signing entitlements, without replacing Keychain storage or relaxing server authentication.

## Subsequent native wallpaper verification — October 25, 2026

Ordinary native run [40216561361](https://github.com/bobbyhwilder/porchday/actions/runs/40216561361), at exact revision `c72e15ff10f77e8bbe3a0828610e30cfad977f8d`, passed the crypto bridge interoperability checks, application build, simulator test suite, and app launch/screenshot step. All six `ProfileWallpaperTests` methods executed and passed: persisted starter selection without rerolling, preservation of an existing profile, a concurrent saved profile winning without a second write, propagation of an unavailable cosmetic save, safe choice/edit/import-field preservation, and native SwiftUI rendering of all four curated tile presets.

These initializer tests use synthetic injected storage responses and exercise the same initializer called after the vault unlocks; they do not constitute another hosted profile-write or encryption test. The actual render test uses SwiftUI `ImageRenderer` in the iOS simulator. No hosted credential secret was supplied, and the opt-in hosted interoperability scenario was not repeated. The independently verified hosted encryption and MFA evidence remains unchanged.
