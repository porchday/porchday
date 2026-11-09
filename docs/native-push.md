# Native iOS and macOS notifications

APNs provider configuration is enabled in staging and production. Signed iOS 239 and macOS 198 support opt-in notifications. A deployed Worker check verified the provider path with an invalid synthetic token; this does not establish physical-device delivery. See [release evidence](evidence/apns-provider-release-2026-11-07.md).

## Configuration and release gate

The API Worker accepts `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID`, and `APNS_PRIVATE_KEY` (the complete PKCS#8 `.p8` key) as private environment configuration. Never commit these values or put them in browser assets. All four are required. The native app must also be signed with the matching push entitlement and environment before exposing its opt-in control. No Apple account is purchased by this implementation.

Production release checks cover provider configuration, deployed transport, session authorization and revocation, automated native parity, and signed app entitlements. Track real-device permission denial, token rotation, foreground handling, author/activity lock-screen preview, tap navigation, logout, and badge behavior under #7. These physical checks are follow-up verification, not production blockers, and remain pending until observed. The configured key supports production; sandbox testing needs a separate sandbox-capable credential.

## API contract

These routes use the existing authenticated `/api/v1` session and rate limits:

| Method and path | Contract |
| --- | --- |
| `GET /native-push/config` | `{enabled:boolean}`; no provider identifiers or credentials returned. |
| `GET /native-push/subscriptions` | `{items:[{id,environment,created_at,last_used_at,current_session}]}`; only the member's records, no raw tokens. |
| `POST /native-push/subscriptions` | `{token,environment:'sandbox'|'production'}` → `{id}`. Token is lowercase hexadecimal, 32–100 bytes; input is bounded without assuming Apple's token always has one fixed length. |
| `DELETE /native-push/subscriptions/:id` | Revoke an owned registration and its queued deliveries. |
| `DELETE /native-push/subscriptions` | Revoke all owned native registrations; browser registrations remain intact. |

The client asks system permission only after the member chooses notifications. It registers the current APNs token under the current authenticated session and retains only the returned subscription ID. Registration opts into the shared `notification_preferences.push` flag without changing `in_app`. Turning that global flag off revokes both native and browser registrations. Native-only opt-out removes native registrations. Ten registrations per member are allowed; the same token/environment cannot belong to two members. Session deletion, expiration, account deletion, a security hold, and suspension invalidate delivery. Restricted members may retain notifications for content they can still read.

## Delivery and privacy

Migration `029_native_push.sql` adds a separate native subscription table, durable notification outbox, and jobs-only provider token cache. Notification creation queues work transactionally. The jobs role claims bounded batches with leases and rechecks the member, session, global preference, unread state, blocks/mutes, current post/comment access, expiration, and group membership immediately before sending. Removed access or deleted notifications suppress queued deliveries.

Non-feed notifications retain the generic “You have a new update” alert and open Notifications. Migration `074_feed_notifications.sql` adds feed publication alerts with the generic body “New activity in your feed”, `aps.badge` containing the authorized unread count, and `destination: "feed"`. Read acknowledgments queue badge-only updates without an alert. Feed delivery rechecks the receipt’s current visibility and unread state immediately before sending.

No names, post IDs, comment IDs, photos, content, keys, or evidence enter APNs. Apple sees the unread count, generic alert, app topic, device delivery token, provider account, and timing. The per-publication collapse identifier is an opaque notification identifier. Tapping opens Feed and fetches authorized state again. Infrastructure stores delivery capabilities as restricted operational metadata; they are not end-to-end encrypted social content.

The sender permits only `api.push.apple.com` and `api.sandbox.push.apple.com`, constructs the device path from validated hex, refuses redirects, uses a bounded timeout, and does not log token URLs, authorization headers, private keys, or provider response bodies. Provider errors are parsed under a 1 KiB limit and reduced to known outcome categories. `apns-expiration: 0` asks Apple not to store the alert; a per-publication collapse identifier coalesces retries of each feed alert; badge-only updates and other generic updates use separate fixed identifiers. Already in-flight or delivered alerts cannot be recalled, including the small interval between the final authorization check and send. Apple describes expiration as best effort, so no strict recall guarantee is made.

`jose` signs ES256 provider JWTs. The jobs-only database cache reuses a token for 45 minutes across Worker isolates; concurrent refreshes reuse the first stored token. This avoids minting a provider token for each notification. The `.p8` private key stays in Worker secrets. Cached JWTs are also delivery credentials: social/database API roles cannot read the cache or invoke its function; telemetry and exports exclude it. Configuration changes use a different cache key, and entries older than 24 hours are removed on cache access.

Delivery retries use bounded backoff, up to eight attempts or 24 hours. Apple 5xx responses wait at least 15 minutes; 429 honors bounded `Retry-After`. Invalid or unregistered device tokens revoke the subscription. Permanent forbidden/payload errors stop that job. Re-enrollment clears old queued work so a late failed attempt cannot revoke a fresh registration. Outbox rows are retained seven days after completion. At-least-once processing can produce a repeated generic alert after a crash; it cannot make a social write.

## Verification

Run `NATIVE_PUSH_TEST_DATABASE_URL=<disposable local postgres URL ending in porchday_native_push_test> npx vitest run apps/api/test/native-push.test.ts`. The test recreates schemas in that specifically named disposable database. It covers real ES256 verification, exact generic payload/Apple endpoints, malformed input, disabled configuration, member/session isolation, restricted raw-token access, persistent provider-token reuse/refresh, registration limits, stale leases, re-enrollment races, expiration, blocks/mutes, opt-out, deletion, and transient/permanent provider responses. All network sends are injected; none send a notification to Apple.

Primary protocol references: [Apple request format and HTTP/2 requirements](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), [provider token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), and [APNs response handling](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns).
