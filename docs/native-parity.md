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

Native inbox behavior remains separate from unread Feed receipts and opt-in new-feed alerts. Signed iOS 239 and macOS 198 support the shared implementation. APNs provider configuration is live; hardware delivery remains open under #7; simulator/build results do not establish actual lock-screen delivery.

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

Native responsiveness acceptance at `252021e`: [iOS CI](https://github.com/porchday/porchday/actions/runs/42278468400) passed 139 unit tests (4 explicit hosted/device skips), 2 UI tests, simulator launch and artifact capture. [macOS CI](https://github.com/porchday/porchday/actions/runs/42278468161) passed all 71 tests. Both include six cache/photo regressions. A local Swift 6 synthetic runner measured 25 concurrent plus 25 warm reads using one origin request, then a new request after invalidation. This measures request reuse, not device frame times. Merged in PR #169; a new signed native build is still required for installed users.

## Feed unread counts and system notifications

The shared SwiftUI client adds an authoritative unread-feed count, one-second foreground visibility acknowledgments, explicit mark-all, Feed tab/sidebar and Dock/icon badges, and Feed notification navigation. Visibility uses the actual viewport intersection and cancels when another tab or scene is active. Read writes preserve the recent content cache. Web uses the same authenticated receipt/read API and visibility rules. Notifications remain opt-in with generic previews; publication receipts exclude old history, own publications and adopted post attachments.

Design and release acceptance: [Feed notifications](../design/feed-notifications.md). Web/API production activation, local visibility/receipt tests and exact-source native CI passed. Signed iOS 239 and macOS 198 are available to the owner’s internal TestFlight group. [Release evidence](evidence/feed-notifications-release-2026-11-06.md) separates deployed sources, signed distribution and APNs provider configuration. Native push is enabled for opt-in; physical lock-screen delivery remains unverified. [#7](https://github.com/porchday/porchday/issues/7) retains physical lock-screen/Dock checks separately from automated parity and web/API deployment.

## Shared web shell

The Apple app entry point now hosts the web UI in one persistent WKWebView. Web features use their actual shared React implementations; the native layer handles OS integration. The prior Swift interface remains reachable for migration without exporting its Keychain keys to JavaScript. The [design](../design/shared-web-native-shell.md) covers exact-origin/frame restrictions, notification registration using the web session, native badge updates, external navigation, picker/download support and upgrade recovery.

Automated coverage: `WebShellTests.swift` validates URL/badge boundaries and retained web-view identity; default-launch UI coverage distinguishes the shell from the legacy native tab UI; `apps/web/test/native-shell.test.ts` verifies notification opt-in, invalid response rejection, logout cancellation, revoked-subscription behavior and badge/visibility bridging. Existing Swift tests continue to cover the migration fallback. These are not claims of measured physical-device speed or photo-library acceptance. Release and device verification remain tracked in #168/#49/#114/#7.

Shared-shell release evidence (November 6): source `5db45bc222d5d454bb4b7983348a34ab4a8645c5`, merged in [PR #172](https://github.com/porchday/porchday/pull/172). [iOS simulator checks](https://github.com/porchday/porchday/actions/runs/42344635063), [macOS checks](https://github.com/porchday/porchday/actions/runs/42344635044) and [web checks](https://github.com/porchday/porchday/actions/runs/42344635015) passed. Production frontend version `7198e0b9-523d-4dd6-9c98-39e432bc9d34` passed authenticated continuity, retained/fresh browser checks and post-activation monitoring. The backend/schema were unchanged. Signed distribution and actual device acceptance remain separately recorded in #49/#114/#168/#7.

Alternate iPhone audio tracks (#174): the shared web preparation path selects a compatible AAC track from source recordings with alternate spatial audio and retains strict single-track output validation. iOS/macOS web shells receive the same implementation without a new native binary. The optional previous Swift interface retains its older preparation limits; it is not the default interface. Original-device recording verification remains pending.

## Saving navigation feedback

The shared web shell measures the mobile navigation dock and positions saving status above it, including safe-area padding and text/layout changes. Mobile and desktop primary navigation expose `aria-disabled` and dim while the existing save guard blocks route changes; logout is disabled too. iOS and macOS use this same React UI. Failed and completed saves release the guard. Physical device layout acceptance is tracked in #177; automated source checks are separate from signed build availability.

## Push settings feedback

Both current Apple shells use the shared privacy settings UI: enrollment is checked for this member/device/server session rather than inferred from the account-wide preference. Checking never prompts or enrolls. The enable action shows explicit progress, then persistent confirmation; setup errors and success are adjacent to the control. Browser permission and subscription are checked where supported, with blocked/Home Screen guidance. Native registration reflects server enrollment; device notification settings still control permission and actual delivery. Physical APNs/Web Push receipt remains tracked in #7; synthetic bridge UI tests are not device delivery evidence.

## Full-video preparation and optional thumbnails

The current iOS/macOS web shells share the fixed preparation UI: no Start/End controls, no crop, full duration/framing, explicit over-10-minute rejection, and “Finishing video…” after conversion. The shared web implementation decodes an optional thumbnail directly from the prepared file with bounded waiting; thumbnail failure does not discard validated media. Cancellation and H.264/AAC validation still apply. Legacy Swift source also removes trimming and exports the full duration; its changed controls require a future signed binary, while current default shells receive the web fix immediately. Exact-source native CI checks this source; original iPhone/device verification remains #174.

## Direct videos and 10 GB storage

The default iOS and macOS shells use the same Share → Photos & videos uploader, resumable encrypted outbox, owner-verified video playback, album grants and portability implementation as the PWA. Videos can be published without a post, preserving dates, captions, tags, comments/reactions and audiences. Total account media storage is 10,000,000,000 bytes; the 1 GiB source, 250 MiB prepared and 10-minute per-video limits remain unchanged. No native bridge changes or new signed binary are needed for the default shells. The optional Previous app remains a migration fallback and does not implement direct segmented-video creation.

[#181](https://github.com/porchday/porchday/issues/181) tracks API/browser acceptance, exact-source native CI and remaining physical Photos-library/upload/playback verification. Automated checks are distinct from installed-device verification and TestFlight availability. [Design](../design/direct-videos-and-storage.md).

Direct-video release acceptance (November 7): [release evidence](evidence/direct-videos-release-2026-11-07.md) records passing exact-source frontend/API native CI, staged and production encrypted upload/playback/export/revocation checks, and final monitoring. Default shells receive the hosted UI update; signed binary availability and physical device acceptance remain separately recorded.

### Unified media selection and capture dates

The shared UI uses one Add photos/videos file input with multiple mixed-media selection. WebKit supplies the native iOS Photos picker, without a replacement grid. Photos read original embedded creation dates before metadata normalization; missing dates require an explicit choice rather than silently becoming today. This works in existing web-shell builds. macOS adds an embedded Share extension and local app-group inbox; a new signed build is required for that entry point. It imports into the same encrypted Share draft, never automatically publishes. Automated tests and physical picker/share-menu acceptance are separate; #183 tracks both. [Design](../design/unified-media-picker.md).

Unified media release delivered November 8: [release evidence](evidence/unified-media-picker-release-2026-11-08.md) records live staging/production, passing exact-source automated iOS/macOS checks, and signed macOS TestFlight build 236. iOS build 247 receives the web UI update without a new binary. Physical picker and Photos share-menu acceptance remains #183.


## Pending encryption setup

November 8, #185: the default iOS and macOS web shells use the same post composer and author-side encrypted catch-up as web/PWA. Social posts and attachments include every ready eligible device; pending direct connections retain publication eligibility tied to the existing connection. This is not a plaintext queue or a read grant. Current eligibility, exact device fingerprints, epoch, expiry, and history checks remain. Catch-up needs the author’s unlocked app after recipient setup. The legacy Swift vault and history preparer use the same scoped pending-member policy; other album/photo snapshots still require their previous checks. Exact-source automated native CI and deployment evidence are required; physical checks are not claimed.


## Share draft autosave

November 8, #187: default iOS and macOS shells use the same persistent Share composer and encrypted IndexedDB draft store as web/PWA. Text, media and sharing choices survive app-tab navigation and reload after unlocking. Storage failures keep the in-memory draft and show an explicit retry; publication/discard clear saved state. The status is inline and does not disable navigation. The app-update action allows a fully saved draft to reload. No new native bridge or binary is required. [Design and automated verification scope](../design/post-draft-autosave.md). Exact-source iOS/macOS CI remains required; physical-device storage eviction and app termination timing are not claimed verified. The optional previous Swift UI remains a migration fallback.

Draft autosave released November 8: [release evidence](evidence/post-draft-release-2026-11-08.md) records deployed UI recovery/publishing checks and passing exact-source iOS/macOS CI. Existing default shells receive the update; physical storage/termination acceptance remains #49/#114.

## Recovered-device access updates

November 8 follow-up, #22/#124: default iOS/macOS shells skip redundant own-device history copies when recovered keys cover the original post/photo and attachments. Genuine peer access updates continue with unchanged server policy. Persistent background catch-up permits member-tab navigation while unload/signout and foreground saves remain protected. Status text describes encrypted access updates rather than reposting. Desktop sidebar omits More; mobile More keeps plain destination links. [Design](../design/recovered-device-history.md). The optional previous Swift UI remains unchanged. Exact-source native automated checks are required; physical new-install verification remains #49/#114.

The rounded native Mac icon (#15) changes AppIcon PNGs generated from the existing corn SVG. It requires a new signed Mac build; web deployment alone does not change installed native icons. Distribution evidence must identify the actual available build.

## Quiet automatic updates

The default iOS/macOS WKWebView shells use the same public-shell build checks and safe reload policy as the PWA, including when service workers are unavailable. Routine update and successful background-access notices are removed. Saved encrypted Share drafts restore; unsaved forms, saves/uploads, dialogs and media playback defer reloading. Failed/limited-functionality notices remain actionable. See [design](../design/automatic-updates.md) and #190. Signed binary installation still follows TestFlight/App Store settings. Exact-source native simulator/macOS checks are required; physical foreground/resume behavior remains unverified under #49/#114.

## Settings organization

The default iOS/macOS shared web shells show wrapping Settings navigation, a distinct Notifications settings tab, and Time zone under My profile. Existing notification preferences, push bridges and timezone storage are unchanged. The same web layout is used on mobile and desktop; exact-source native builds/tests remain required. Physical-device layout follow-up stays in #49/#114; owner navigation follow-up is tracked in #124.

## Notification previews and tap handling

November 8 follow-up (#7): Web Push and APNs show a validated author handle and post/media activity type after the existing delivery-time access check. Encrypted text, captions and media remain absent. Shared Settings copy reflects this disclosure. Native iOS/macOS callbacks use an explicit nonisolated completion-handler boundary, queue navigation on MainActor, ignore dismissal/custom actions, and retain destinations before the web shell mounts. Production taps no longer initialize the legacy native notification model. Payload-free OSLog breadcrumbs support crash investigation.

The owner reported an iOS TestFlight crash after tapping a notification. App Store Connect returned no submitted crash diagnostics at investigation time; root cause remains unconfirmed. Automated background-callback ordering, dismissal and malformed-payload checks are included in both native test targets; real-device crash reproduction and device acceptance remain pending in #7. Do not equate callback hardening with a verified crash fix.

[Release evidence](evidence/notification-previews-release-2026-11-08.md): staging and production checks pass; iOS 304 and macOS 267 are processed and available in the existing TestFlight group. This verifies distribution, not physical-device notification delivery or crash resolution.

## Automatic access-update retries

The default iOS/macOS shared web shells use the same bounded, automatic access-update worker as the PWA. No new native binary or bridge is needed. Foreground/online checks resume interrupted work; per-item capped backoff replaces manual retry. Unknown writes are reconciled before identical-byte resubmission, and current server audience checks remain unchanged. Exact-source native CI is required; physical suspend/resume acceptance remains #49/#114 and member-specific history confirmation remains #22.

[Automatic access recovery release evidence](evidence/automatic-access-recovery-release-2026-11-08.md): the shared client is live in staging and production, exact-source iOS/macOS CI passes, and hosted synthetic failures recover without manual retry. No new signed binary is required.

## Detailed diagnostic recordings

Issue #196 uses the shared web UI and IndexedDB collector inside the iOS and
macOS thin shells. Both receive identical consent controls, capture exclusions,
recording indicator, retries and timeline without a native bridge change. Native
OS crash reports and background execution while the app is suspended are not
provided by this collector. Browser tests cover consent, account isolation and
offline outbox recovery; installed-device verification remains pending. This
entry is an implementation audit, not evidence of a new binary or production
deployment.


## Encrypted notification content previews

The shared composer prepares a signed, encrypted 240-character excerpt/caption and optional bounded JPEG. Each enrolled push device has a separate notification-only key. iOS and macOS embed a notification service extension which retrieves authorized ciphertext, verifies the pinned author key/signature, decrypts using CryptoKit and attaches the thumbnail. Main account/recovery keys never enter the extension. The PWA service worker uses its own nonextractable IndexedDB key. Unknown/unpinned authors, old binaries, unavailable keys, stale access, deadlines and invalid payloads fall back to generic alerts.

Shared Settings provides a per-device preview toggle; system notification settings control lock-screen visibility. Sign-out and opt-out clear local preview keys. Notification taps use allowlisted post/photo destinations. Native signing must include the new extension bundle and shared notification Keychain group. A web deployment cannot add this extension to an installed old binary.

Automated validation: `NotificationPreviewTests` consumes a synthetic WebCrypto/OpenPGP fixture on both Apple platforms; API feed-read tests exercise capability expiry, mute, revoked devices/session and revision checks. Exact-source native CI and production evidence are recorded during release, not assumed here. Physical lock-screen, attachment and tap acceptance remains pending under #7/#49/#114.


## Reaction attribution

The shared web shell uses the same ReactionChips component for post, comment and photo reaction details on iOS and macOS. Long-press opens the list on touch; right-click and View reactions provide desktop and keyboard access. Normal clicks still toggle reactions. Photo lists retain pagination. No native bridge or binary change is required. Chromium/WebKit gesture regression covers inspection without mutation and scroll cancellation; physical iOS/macOS acceptance remains tracked in #201. Production deployment and exact-source iOS/macOS CI passed; see [release evidence](evidence/reaction-access-release-2026-11-09.md).


## Photo history pending keys

Original social-photo access refresh now permits pending-key members while requiring every currently eligible ready device; server history policy continues to control later catch-up. Album refresh behavior is unchanged. Shared iOS/macOS shells use the same worker, including page draining and silent automatic retries. No native bridge change is needed. Exact-source iOS/macOS CI and production deployment passed; [release evidence](evidence/reaction-access-release-2026-11-09.md). Member-specific acceptance remains #22.


## Clickable post links

Shared post text renders HTTP/HTTPS and www links as safe React anchors while preserving plain text and punctuation. Browser links use a separate tab with noopener/noreferrer. Existing WebShell navigation delegates open external URLs using UIApplication/NSWorkspace on iOS/macOS and keep the Porchday web view in place. No bridge or native binary change is needed. Chromium/WebKit link activation tests and tokenizer tests pass, as do exact-source iOS/macOS CI and hosted staging/production link activation. See [release evidence](evidence/clickable-post-links-release-2026-11-09.md). Physical external-browser handoff remains a follow-up in #203.


## Post deletion feedback

The shared PostCard used by web, PWA, iOS and macOS now shows Deleting post immediately after confirmation, suppresses duplicate submissions, and replaces the post with Post deleted on server confirmation independently of parent refresh. A failed request restores content with an actionable error above the post. The state is scoped to the post identity. Mobile Chromium/WebKit browser tests cover cancellation, delayed response, failure/retry, success with stale parent data and identity reuse. No native bridge change is required. Exact-source native CI and hosted staging/production acceptance passed; physical-device acceptance remains pending in #205. See [release evidence](evidence/share-feedback-release-2026-11-09.md).


## Composer footer and confirmed post handoff

Share, smaller Discard draft and local draft status are grouped in the bottom footer after media guidance and audience controls. Video/storage guidance is collapsed by default and the attachment subsection heading is smaller. Restore/save retry controls remain outside the disabled draft fieldset. Shared iOS/macOS shells use the same UI without a bridge change.

After a post is confirmed, the Share tab opens Feed with that post immediately rendered from the author's in-memory confirmed row/content. It does not wait for the feed read or decryption round trip. Matching server rows reconcile without duplication; the temporary row is account-scoped, cleared on logout and respects expiry. Failed publication stays in Share with the draft intact. Tests exercise a deliberately held feed response, reconciliation, failed publication and encrypted draft recovery in Chromium and WebKit. Exact-source native CI and hosted staging/production verification passed; physical verification remains pending in #207. See [release evidence](evidence/share-feedback-release-2026-11-09.md).

## App-switcher background (#208)

The shared native iOS/macOS privacy cover follows the web UI's selected opaque background color (Autumn, Clean or generated pattern palette). A main-frame-only script observes appearance application; the existing exact-origin bridge accepts only six-digit hex colors. Only that color is cached locally for relaunch, with Autumn as the default. The cover remains opaque and its label chooses a contrasting foreground; no page screenshot or member content crosses the bridge. This is native-only and requires an updated signed app. Exact-source iOS/macOS tests and signing passed; iOS 362 and macOS 345 are available in internal TestFlight. Physical-device app-switcher verification remains pending in #208. See [release evidence](evidence/app-switcher-appearance-2026-11-09.md).

## Composer timer placement (#207)

The shared web/PWA/iOS/macOS composer places the expiration selector in the bottom action area with Share, below media and audience controls. Its preset and custom inputs remain disabled while publishing, importing or restoring a draft. The informational paragraph about people still setting up sharing is removed; sharing behavior is unchanged. No native bridge or signed binary change is needed. Production rollout is pending.
