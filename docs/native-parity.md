# Native parity release policy

The owner requires iOS and macOS to catch up before every forward production release. Web, iOS and macOS are one product release scope; browser-only features are not silently accepted as native parity. Shared SwiftUI code implements both native targets. Platform-appropriate controls are acceptable; equivalent behavior, permissions, history, recovery and data ownership are required.

`docs/native-parity.json` is the machine-readable capability checklist. Version 2 separates `implementation` from the `ios`/`macos` acceptance status. Both implementations must be `implemented`; missing implementation still blocks production. Hosted-native interoperability and physical-device acceptance may remain `pending` with `followUpIssues` links and do not block production. Evidence remains honest: a pending check is not a pass. Version 1 matrices retain their historical all-verified meaning. `scripts/release-native-parity.ts` reads this matrix from the exact candidate commit and verifies successful exact-source **push** runs and jobs for both native workflows. Native CI runs for every push, including backend-only changes. The maintained activation CLI invokes this check before fresh production activation; it leaves already durable recovery/rollback intents usable.

Private release wrappers and pinned release-tool worktrees must be updated to include this gate before their next forward production release. Using an old tool pin to bypass the gate is prohibited. No unverified device behavior, installer, TestFlight build or App Store listing may be marked complete. Signing/distribution evidence remains #49/#114; push-device evidence remains #7. The matrix is deliberately pending while this parity pass is under validation.

## navigation

Shared MainTabs uses Feed, Share, Albums, Connections, More. Desktop adds Groups, Notifications, My wall, Feature additions and Settings. More retains Builder chat and logout. Feed uses a stack icon; feature additions uses a code icon. Validate real iPhone/iPad/Mac layouts and access gates.

## feed

NativeFeed uses the same authorized `/photo-feed` API as web, with Everything/Posts/Photos and Only me/Friends/Family/Friends & Family/Extended family/Community. Default Everything + Friends & Family includes own activity and independent photos. Server controls deduplication and publication ordering; client filters never expand permissions. Calendar uses photo dates, separate from post dates, with older months above and newer below. Pagination, signature failures and refresh need acceptance.

## albums

NativeAlbums implements create, list, role-based access, people/permissions, rename, leave, deletion, ownership transfer, existing-photo selection and Share routing. Existing picker retains partial progress and closes on complete success. Adding album access preserves prior grants. Read-only members cannot add; admin sharing refresh preserves the original owner proof. Validate revoked/blocked recipients, revision conflicts and restored keys.

## photo-sharing

Shared NativePhotos publishes encrypted independent photos/videos and verifies source proof, metadata and bytes. Stable draft IDs reconcile uncertain publication. Share offers Post/Photos without discarding the other draft. Albums preselect Share → Photos. Existing attachments can be adopted while the original post remains readable to its existing audience.

## photo-dates

Photo contexts require valid Gregorian dates; post contexts reject custom dates. Independent photo edits resign every accessible grant against its exact audience/revision and update linked source dates. Existing attachment-only date editing and selection/date controls require validation.

## audiences

Native crypto and sharing choices include Community and Extended family. Server audience snapshots define relationships; native clients do not infer access from display filters. Family is mutual. New encryption recipients with missing keys stop sharing instead of being silently omitted.

## invitations

Invitation UI and request send full-history by default or explicit future-only. Receipts display persisted choice; legacy missing values remain future-only. Connection choice remains independently directional.

## history

Native foreground catch-up refreshes eligible posts and independent photos, using server-derived recipients. Album additions share decryptable history; retry remains available. Bounded passes stop on logout/account change and preserve failures for retry. Validate second-degree changes independently of direct-connection history choice.

## portability

Native archive import/export now includes albums, standalone photos and attachment dates. Imports restore albums privately, retain earlier expiry deadlines and reconnect adopted post attachments using account-scoped stable identities shared with the web importer. A shared album cannot silently receive a private import. Multipart completeness and missing referenced media fail closed. Contract round-trip tests are added; hosted round-trip and interrupted-import acceptance remain tracked under #49/#114 as follow-up verification, not production prerequisites.

## notifications

Existing native inbox, badge and opt-in mention push implementations remain. Hardware APNs delivery, permission defaults, disabled push behavior and release signing capabilities require existing #7 device acceptance; simulator/build results do not substitute for it.

## Release checklist

1. Compare candidate changes with all capabilities; implement both native equivalents in the same release or retain pending status.
2. Run cross-language crypto/contract tests, native build/tests on both platforms and relevant web/API regressions. Record skipped/failed checks.
3. Verify native workflows against the exact candidate source, not a previous branch or PR merge commit.
4. Complete staging acceptance, including old-client compatibility, privacy boundaries and uncertain-write handling.
5. Activate production only through updated maintained tooling with reviewed implementation parity and CI evidence. Hosted-native and physical-device checks are non-blocking follow-ups; retain pending statuses and issue links. Keep existing continuity, schema, rollback and artifact gates.
6. Record separately what is merged, hosted, signed, distributed and verified on devices. Close issues only when their acceptance is met.

## Photo conversations (issue #151)

The candidate adds the shared `NativePhotoInteractions` view to photos in Feed and Albums, a photo feed label, six reaction choices and encrypted comments. Web and native use the same `photo` audience protocol and own-contribution archive section. Photo-sharing/feed/albums/portability rows remain pending until hosted cross-client and device checks verify the candidate. Exact-source build results are recorded on #151; no matrix row is promoted by compilation alone.

## Owner policy update — November 4, 2026

Hosted-native and physical-device checks are no longer prerequisites for pushing to production. The version 2 matrix records the already implemented shared SwiftUI capabilities separately from outstanding manual acceptance. Exact-source iOS simulator/macOS automated tests, implementation parity, normal staging web/API acceptance, schema checks, continuity and rollback requirements remain required. Signing, TestFlight and App Store distribution remain separate work. This policy does not assert that any pending test has passed.

## Photo viewer and action-row parity — November 4 follow-up

Shared iOS/macOS source removes the feed Photo badge, exposes reaction chips and a separate Comment action, and reuses ReactionPicker for legacy, Unicode and custom image reactions. ViewablePhoto is used by post attachments and standalone photo cards; its focused sheet supports pinch/magnification, pan, zoom buttons, reset, close and expiry dismissal. Web uses the same interaction model in a full-window dialog. Exact-source CI is required before release; device gesture acceptance and distribution remain pending under #49/#114.

## Unified activity headers

Feed photos and posts share ActivityAuthor on web and ActivityAuthorView on iOS/macOS: avatar, author, and a compact date/lock metadata line inside the card. Photos show their editable photo date; posts retain publication time. Standalone photos say “Shared photo” because visible grants do not necessarily describe every audience or album with access. Attached-post photos retain post audience context. No access policy changes. Native physical-device acceptance remains a follow-up under #49/#114.

## Connection limit

Web, API and shared iOS/macOS connection counters and capacity controls use 150 accepted connections, including family. Migration 072 enforces the same limit for both endpoints during normal acceptance and invitation verification, retaining locking, history preferences and existing connections. Group and album limits are unchanged. Exact-source native CI is required; device and distribution follow-ups remain under #49/#114.

## Signup guidance and Feed label — November 6

Web and shared iOS/macOS rename the chronological view button to Feed (Calendar remains the alternate view). Native LoginView now has a check-email state, one-hour expiry/login/setup guidance, address retention in view state, resend with cooldown and neutral eligibility copy, invitation-context validation and the corrected full-history disclosure. Both native targets use “Set up private sharing” and retain recovery-secret safeguards. Verification links use the canonical browser result screen; returning to native login still requires password and existing two-factor checks. No automatic cross-app session transfer is introduced. Inbox and physical-device handoff checks remain follow-ups under #27/#49/#114; exact-source native CI is required before production.

## Larger videos — November 6 implementation

Shared iOS/macOS source now includes file-backed movie selection, AVFoundation trim and 1080p/720p preparation, encrypted segment uploads with durable retry state, AVPlayer range loading, history manifest rewraps, and bounded archive segment export/import. Web uses the same AES-GCM manifest/AAD contract; `scripts/check-video-crypto.mjs` verifies both encryption directions. `SegmentedVideoTests` exercises preparation/audio preservation and integrity failures. Archive and upload tests cover browser reload, uncertain publication and damaged/missing pieces. Existing v1 media remains readable.

Exact-source iOS simulator and macOS build/tests passed before production activation for the frontend and both preserved API runtime sources. A CryptoKit Data slice indexing failure found during CI was corrected and covered by regression tests. [Release evidence](evidence/larger-videos-release-2026-11-06.md) links the passing jobs and live web/API acceptance. Native signing/distribution and physical-device performance checks remain follow-ups under #108; simulator and hosted-Mac results do not imply device or store acceptance.

## Native responsiveness — November 6

Work under #168 adds a foreground-only, bounded memory cache for selected presentation GETs (20 seconds, 32 MiB), single-flight concurrent reads, verified payload reuse (24 MiB) and decoded JPEG reuse (64 MiB), with JPEG validation/pixel decoding off the main actor. Authentication/bootstrap, audience snapshots, exports and video authorization/chunks are excluded. No cache files are written. Reads invalidate before/after writes, on session changes, backgrounding, memory pressure and explicit refresh. Cached content still checks its signed expiry; other-device changes may take up to 20 seconds to appear on a subsequent read.

Feed keeps its visible rows during refresh, retains its store across tab selection, publishes initial results progressively, and preserves loaded pages on warm returns. Pagination requires the existing Load more control instead of repeatedly fetching from the footer's appearance. Expiry-driven schedules replace whole-list one-second redraws. Session cookies reach Keychain only when changed. History sharing emits one feed invalidation per bounded pass. Both iOS and macOS share these implementations; automated and physical-device timing results are recorded in #168, separately from signed distribution.
