# Feed unread counts and notifications

Status: web/API live; iOS 239 and macOS 198 available in internal TestFlight. Native APNs provider setup and device verification remain pending. [Release evidence](../docs/evidence/feed-notifications-release-2026-11-06.md). Tracking: [#7](https://github.com/porchday/porchday/issues/7). November 6, 2026.

Porchday should show how much new activity is waiting and let members catch up by scrolling. The Feed badge counts unread posts and standalone photos. Members can opt into a system notification for every new eligible feed item. This extends the existing notification inbox, durable Web Push/APNs queues, and shared native Apple client.

## Member experience

The Feed navigation item shows the unread count, with an accessible label and a compact visual cap of 99+. Supported installed app icons and the macOS Dock show the same count. Zero clears the badge. The count covers the authorized default feed, regardless of temporary author, content or calendar filters. A member's own publications do not count as unread.

An item becomes read after its readable content has been visible in the foreground for one continuous second. For large cards, visibility uses the smaller of half the card height and half the viewport height, so tall posts can qualify. Merely loading a page, decrypting offscreen, visiting another tab, opening a notification, or quickly flinging past an item does not mark it read. Failed or locked content stays unread. Read acknowledgments are batched and idempotent; pending acknowledgments are retried while the authenticated session remains active. Read items stay in the feed with their existing chronology. A “Mark all as read” control provides an explicit alternative, using a server snapshot cutoff so concurrent new items stay unread.

Read state is shared across devices and is separate from inbox notifications. Reading a feed post does not dismiss unrelated connection, comment or mention notifications. Marking an inbox notification read does not imply the underlying feed card was read. Filters never mark hidden items read.

## System notifications

System notifications are off by default. Settings explains “Notify me about new feed posts and photos” and requests operating-system permission only after Enable. The owner confirmed every new feed post, rather than only mentions. Existing opted-in registrations retain their choice; update the settings explanation to cover the expanded event scope. Counts and alerts use the default Friends & Family feed; selecting a wider temporary filter does not expand the notification audience. Disabling notifications removes that device's registration through the existing supported API. Existing global opt-out continues to revoke all delivery registrations.

Each newly published, currently accessible feed item can generate an alert for opted-in devices. Push carries a generic Porchday preview (“New activity in your feed”), the authorized unread count, and a destination identifying the Feed. It never contains decrypted text, photos, names, keys or captions. Tapping opens the authenticated feed, which checks access and opens encrypted content normally. Existing notification kinds keep their inbox destination. Read-state updates refresh badges without producing an alert. Native APNs supports badge-only messages; Web Push requires a visible notification, so browser badge clearing reconciles while a client is open rather than sending invisible browser pushes.

The operating system controls lock-screen presentation, grouping, Focus suppression and badge permission. macOS uses Notification Center for alerts and the Dock for its count; iOS uses lock-screen/Notification Center alerts and its app-icon badge. Browsers use their supported service-worker notification and Badging APIs. In-app badges work without push permission; icon updates while the app is closed require supported permission and delivery. No polling loop or silent notification is promised to run reliably on a suspended device.

## What is new

Use publication time, never the user-editable photo date, to identify new activity. Standalone photos count once; attachments represented by their parent post do not add extra feed alerts. Edits, comments, reactions, photo album membership, historical envelope catch-up, and a newly granted connection path do not create new-publication notifications. Comments and mentions retain their separate inbox behavior.

Start publication receipts at rollout so historical content is not newly badged or pushed. New members receive receipts only for publications they are eligible for at publication time. A first device installation reads existing server state rather than resetting another device's progress. Newly accessible old history stays readable without becoming a new-publication alert. Do not backfill millions of per-member read rows.

## Server design

Add backward-compatible publication receipts per eligible recipient under row-level authorization. Only publications after activation create receipts, so historical activity needs no backfill. Each acknowledgment contains a typed post/photo identity, is limited to bounded batches, and verifies current feed eligibility. Mark-all updates the currently visible unread receipts in one database statement snapshot; concurrently committed later receipts remain unread. Unknown or inaccessible IDs cannot disclose metadata or mark other members' items.

Provide authenticated endpoints for unread count, bounded read acknowledgments, and snapshot-based mark-all. Counts must use the same current eligibility rules as the unified feed: active content, membership, blocks/mutes, audience and expiration. Removed, expired or inaccessible activity drops out. Return a state revision or equivalent ordering guard so delayed responses cannot restore an obsolete badge. Counts are authoritative on the server; client optimistic acknowledgment can improve responsiveness but reconciles on refresh.

Generate new-feed events transactionally on publication using a durable queue and unique recipient/item identity. Recheck authorization immediately before each delivery. Reuse the existing bounded leases, retry limits, subscription/session cleanup and provider credentials. Replays cannot create a fresh publication event. Historical grants must not accidentally enter this path. Keep publication queries indexed and avoid scanning/decrypting the entire feed on every badge refresh.

Push delivery is at least once, so a retry can repeat an alert. Use a stable per-item notification identity to replace repeats without collapsing all distinct publications into one alert. Badge-only synchronization uses a separate coalescing identity and never displays a new alert. Reconcile counts when the app foregrounds and after read acknowledgments; stale or reordered provider delivery must not permanently overwrite authoritative foreground state.

## Client implementation

Web observes successfully rendered cards with an IntersectionObserver plus foreground/tab visibility and a cancellable dwell timer. Disconnect observers on unmount and clear pending work on logout/account change. Share one bounded read-acknowledgment coordinator and unread store across Feed, navigation and the service worker. Keep recent feed caching intact.

iOS and macOS share a feed-read coordinator, server state and notification payload parser. SwiftUI visibility measurement must account for actual viewport intersection, not onAppear prefetch. Cancellable dwell timers only run while the Feed is selected, the scene is active, and content is unlocked. Update the Dock badge on macOS and the UserNotifications badge on iOS. Clear counts and delivered local notifications on sign-out. Enable native push only in properly signed distribution builds with the matching configured provider.

## Verification and delivery

Automated checks cover default baseline, own posts, independent photos versus attachments, backdated photos, historical grants, current audience/blocks/mutes/expiry, batch isolation, mark-all races, duplicate/reordered requests, notification deduplication, preference/session revocation, provider payloads and badge-only delivery. Browser checks cover fast scroll, continuous dwell, tall cards, background tabs, locked cards, tab changes, filters and account changes. Native contract tests cover the same dwell/read lifecycle and payload state.

Publish the design and implementation with #7 and ROADMAP updates. Run the normal API/browser checks, disposable database migration/authorization tests, and exact-source iOS/macOS CI. Deploy backward-compatible schema/readers before enabling event production, then verify staging and production with isolated synthetic accounts and clean up test artifacts. Preserve the existing production runtime configuration and use the maintained release activation/parity gate. Document the writer rollback floor and disable new delivery first if reverting.

Configure existing Web Push/APNs provider infrastructure through private secret handling and verify provider responses. Deliver updated signed iOS and macOS builds separately from web/API deployment. Physical lock-screen, Dock, permission denial, foreground/background, token rotation and install checks remain explicitly tracked verification; they do not block web/API production. Never claim a device received an alert based solely on a successful API response or simulator test.
