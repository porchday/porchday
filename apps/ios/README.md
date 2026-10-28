# Porchday for iOS

The native client uses SwiftUI and URLSession with the same authorized social API and signed encrypted envelope format as the web client. It is not a web-view wrapper. Photo processing, encryption, recovery, multipart export/import and Keychain storage run on the device.

## Build and test

Requirements:

- macOS with **full Xcode**, its selected developer directory, and an installed iOS Simulator runtime. Command Line Tools alone are insufficient.
- Go matching [go.mod](../../packages/crypto/native/go.mod), currently 1.27.3, and XcodeGen.
- Node 24 and npm for the shared JavaScript/native interoperability tests.
- Network access to retrieve the pinned npm, Go and Swift package dependencies.

From the repository root:

```sh
npm ci
(cd packages/crypto/native && go test ./...)
apps/ios/build-native.sh
xcrun simctl list devices available
```

The build script creates `packages/crypto/native/build/Porchcrypto.xcframework` from the pinned GopenPGP/gomobile dependencies, then generates `apps/ios/Porchday.xcodeproj` from [project.yml](project.yml). Edit the source configuration rather than the generated project.

Choose an available iPhone simulator UUID from the list. Substitute it in this command:

```sh
xcodebuild -project apps/ios/Porchday.xcodeproj -scheme Porchday \
  -destination 'platform=iOS Simulator,id=YOUR_SIMULATOR_UUID' \
  -derivedDataPath apps/ios/build/DerivedData \
  test
```

Do not add `CODE_SIGNING_ALLOWED=NO`: the simulator's real Keychain tests require entitlements in an ad-hoc signature. The project signs simulator builds ad hoc and keeps physical-device signing separate. A simulator build needs no Apple Developer account, App Store listing or hosted Porchday credentials. The suite includes real Keychain write/read/update/delete and device-only accessibility checks, alongside crypto, reactions, profile, portability and onboarding tests.

The [native CI workflow](../../.github/workflows/ios.yml) selects an installed simulator, runs these checks, and captures the app, result bundle and screenshot for seven days. Dated successful runs and limitations are in [build status](../../docs/build-status.md). Local Go interoperability tests are not a substitute for an Xcode compiler/simulator run.

## Server selection and hosted tests

New normal builds target **https://porchday.org**; the [domain migration guide](../../docs/domain-migration.md) and [issue #17](https://github.com/porchday/porchday/issues/17) record the cutover and remaining device checks. Existing `.com` clients retain their compatibility API during the transition. There is no general localhost server selector; the client requires its configured HTTPS origin. Do not use an ordinary simulator launch to create synthetic accounts on production.

The DEBUG-only `--ui-testing` argument skips automatic session restoration for unauthenticated onboarding UI tests. It supplies no session and bypasses no server authorization. The standard CI workflow uses no production credentials.

The separate [hosted native procedure](../../docs/hosted-native-verification.md) uses prepared, short-lived synthetic staging accounts for real login, recovery/device enrollment and web/native encrypted posts/photos. Its DEBUG-only `PORCHDAY_HOSTED_STAGING_TEST=1` setting selects a fixed staging origin and separate Keychain namespace; release builds ignore it. That procedure requires explicit operator preparation, and a skipped step remains incomplete. Private hosted test logs/results are not uploaded as CI artifacts.

## Privacy and data handling

Login cookies and private device keys use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Keys are not synced to iCloud or written to user defaults. Private content opens in memory; URLSession uses neither an HTTP response cache nor a shared cookie store. A privacy cover obscures the app in the app switcher. Sign-out removes local keys/session state and staged archives.

The account password is independent of the randomly generated encryption recovery secret. Restoring an active account authorizes a new device with the recovery signing key while retaining decryption keys for history. A suspended account can open its backup for export without adding a publishing device. Device fingerprints are pinned locally; this is not an independently witnessed transparency service. See the [protocol](../../docs/crypto-protocol.md) for visible metadata, the absence of forward secrecy and the independent-review requirement.

Posts and comments share the reaction picker: multiple Unicode or custom-image reactions per member are supported. Unicode metadata is bundled from the shared pinned dataset. Clients validate each reaction descriptor and tag before display; uploaded custom images are normalized locally, while received images retain their exact validated identity. Personal emoji libraries are encrypted and included in the optional archive field.

## Data portability

Archives use the shared versioned JSON, image and ZIP/OpenPGP formats. Parts hold up to 20 MiB of estimated raw material, with a 30 MiB limit per ZIP. Each part identifies its archive set and index; the final part supplies the total and completion marker. Imports require every part and validate IDs, paths, CRCs, image checksums and deadlines. Up to 1,000 parts are accepted, processed separately to avoid holding the entire photo library in memory. See the [archive contract](../../docs/archive/README.md).

Export defaults to encryption with a separate archive secret; plaintext ZIP is an explicit choice. Staged files use complete file protection. User-saved exports cannot be recalled when content expires. Imports re-encrypt contributions for the destination account and start as Only me; comments/reactions and standalone photos become private journal posts. Connections and memberships are reference data, and imports do not send invitations or recreate other people's threads.

## Profile appearance

Profile wallpapers use the same four curated IDs as the web client: `porch-stars`, `orange-checker`, `sunny-daisies`, `midnight-diamonds`, plus `none`. SwiftUI draws these locally; profile values cannot become URLs, markup or code. On first unlocked access, an account without a saved profile gets a random choice through revision-one creation. An existing profile always wins, and conflicting saves are reread without overwriting. Failure of this cosmetic setup leaves account access and keys intact.

The editor previews and changes the stored choice. Export/import and unrelated edits retain it, including unknown future values, which render without a pattern. The device-local **Use standard theme** switch hides wallpapers, custom background photos, heading styles and section order without changing encrypted profiles. This is separate from the web site's device-local Autumn/Clean/generated background controls.

## Physical devices and distribution

Simulator verification does not establish physical-device, APNs or Universal Links behavior. A physical build needs a real signing identity and provisioning selected in Xcode. App Store/TestFlight distribution and notification/domain capabilities require separate Apple setup and operator approval.

The checked-in entitlements declare both `applinks:porchday.org` and `applinks:porchday.com`, plus an APNs environment variable. Simulator CI uses its own app-local Keychain entitlement and `PORCHDAY_PUSH_ENABLED=NO`. For a physical build, configure the real development team, Push Notifications and Associated Domains for `com.porchday.app`, enable signing, set `PORCHDAY_PUSH_ENABLED=YES`, and select the matching `PORCHDAY_APNS_ENVIRONMENT`. An APNs provider private key belongs only in the operator's backend secret storage, never the app or repository.

The permission button appears only when the build flag and `/api/v1/native-push/config` both enable delivery. Only pressing **Enable** requests authorization. Opted-in launches register the current token through the authenticated API; token bytes are not cached on disk. Opt-out and sign-out remove the subscription and unregister locally. Notifications contain generic text and open the authorized inbox; no extension decrypts private content.

For Universal Links, publish the correct Apple application identifier and `/app/post/*` components in `/.well-known/apple-app-site-association`, without a redirect. The client validates `https://porchday.org/app/post/{UUID}` and legacy `https://porchday.com/app/post/{UUID}` links, but the presence of client code does not prove deployed domain association. Record real-device push and link tests after signing is configured. See Apple's [APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns), [notification permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications) and [Associated Domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains) documentation.

A passing build is not a security audit. Broader launch also requires independent encryption review and the remaining [admission requirements](../../docs/operations.md#admission-and-launch-gates).

## Licenses and rebuilds

The About screen contains bundled third-party notices. From the repository root, regenerate them with `python3 scripts/build-third-party-notices.py`. Original Porchday source is Apache-2.0; dependencies retain their own licenses. Source packaging and replacement-build details are in [third-party notices](../../THIRD_PARTY_NOTICES.md).

## Feature parity review (October 28, 2026)

This is a source audit, not a claim of complete physical-device acceptance.

| Web capability | Native status / evidence |
| --- | --- |
| Feed, walls, group posts, threaded comments, edits, deletion, deadlines | SwiftUI SocialViews and CommunityViews; social API shared with web |
| Friends/family labels and history-sharing choices | ConnectionsView, ConnectionHistory, HistoricalPostSharing; sharing and history tests |
| Unicode/custom reactions and personal emoji | ReactionViews, EmojiLibrary; ReactionsTests |
| Encrypted photos, avatars, profile and group customization | PhotoPipeline, ProfileAvatar, ProfileEditor, GroupEditor; photo/avatar tests |
| Sent invitations and joined notifications | PlatformInvitationSection; PlatformInvitationTests |
| Recovery, Keychain, trusted devices, data export/import and deletion | CryptoVault, SettingsView, PortableArchive; access, Keychain and deletion tests |
| Profile visibility | Native editor now loads and preserves Only me / Friends & family, applies the chosen audience to photos, and rejects a changed editor snapshot |
| Manual Light/Dark/System and display timezone | DisplayPreferencesSection; DisplayPreferencesTests. Device-local, independent of encrypted profiles |
| Two-factor login | Native challenge screen; enrolling/managing 2FA and changing email currently open the website |
| Integration grant review/revoke | Native; registration/authorization opens the website |
| Appeals | Website handoff from native settings |
| Builder chat | Intentionally web/PWA-only in the first-version design; native chat remains postponed |
| Browser-generated backgrounds | Browser-specific; native has profile wallpapers and standard-theme override |
| Push and post links | Implemented, but signed physical-device acceptance remains open in issue #7 |

The native UI is not pixel-identical to the website. Full in-app workflow parity
is not yet established for browser handoffs above. Do not call simulator success
proof of APNs delivery, installed-app upgrades, real-member recovery or link routing.

## Install on your iPhone or iPad

**Recommended for a small group: TestFlight.** Testers install Apple's TestFlight
app, open the invitation email/link, tap Accept and Install, then sign in to
Porchday. Existing members need their own encryption recovery secret to authorize
the new device and open old posts. Keep the working web installation until that
has succeeded; never send recovery material to a maintainer.

There is not yet a verified TestFlight invitation URL or signed distribution
build recorded here. A simulator artifact cannot be installed on an iPhone.

### One-time maintainer setup

1. Enroll in the Apple Developer Program, or use your existing team. Apple lists
   US$99/year; eligible nonprofits may request a fee waiver. Testers do not need
   paid developer accounts. Organization enrollment and approval may take time.
2. Install full Xcode and its iOS platform support. Select it in Xcode Settings
   → Locations → Command Line Tools. Install XcodeGen and the Go version listed
   in go.mod, then run the build commands above.
3. Register `com.porchday.app` in your Apple team and create its App Store Connect
   app record. Confirm the identifier is available to that team before signing.
4. Open the generated `apps/ios/Porchday.xcodeproj`. Select the Porchday app target,
   your real development team and automatic signing. The source defaults have
   device signing disabled: explicitly set `CODE_SIGNING_ALLOWED=YES` for device
   builds. Keep team IDs/signing overrides local; do not commit certificates or keys.
5. Enable Push Notifications and Associated Domains on the App ID/provisioning
   profile, matching the checked-in entitlements. TestFlight uses the production
   APNs environment. Enable the app push flag only when backend APNs configuration
   is ready. The entitlement still requires provisioning even while the UI flag is off.
6. Select a generic iOS device destination and Product → Archive. In Organizer,
   choose Distribute App → App Store Connect. Use a new build number for each
   upload. Do not choose “TestFlight Internal Only” if this build is intended for
   external testers.
7. Complete App Store Connect's encryption questions accurately: Porchday embeds
   OpenPGP/GopenPGP, not just HTTPS or Apple-provided encryption. Do not blanket-set
   `ITSAppUsesNonExemptEncryption=NO`; complete Apple's questionnaire and any
   required documentation before distribution.
8. Start with an internal tester who already has appropriate App Store Connect
   access. For friends, create an external testing group, provide beta review
   information and a suitable review-access process, submit the first build for
   beta review, then send invitations after approval. Do not grant friends team
   administration merely to skip external testing review.
9. On a physical phone verify login/recovery, photos, posting/commenting, background
   and foreground behavior, sign-out, push permission/delivery/tap and supported
   links. Record results in issue #7; use synthetic content for maintainer tests.

### Direct Xcode installation instead

TestFlight is optional for your own development phone. Connect and trust the
phone, enable Developer Mode when prompted, select it as Xcode's destination,
configure signing, then press Run. A free Personal Team has seven-day provisioning
and capability limitations; the current production target declares push and
associated domains, so it is not a drop-in free-team build. Use the paid team
for testing those capabilities. TestFlight is more convenient for ongoing use
and sharing updates; beta builds remain usable for up to 90 days.

References: [Apple TestFlight](https://developer.apple.com/testflight/),
[personal-device provisioning](https://developer.apple.com/help/account/basics/about-your-developer-account),
[enrollment](https://developer.apple.com/help/account/membership/program-enrollment),
[external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers),
[encryption questionnaire](https://developer.apple.com/help/app-store-connect/manage-app-information/determine-and-upload-app-encryption-documentation).
