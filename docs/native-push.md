# Native iOS notifications

APNs delivery is implemented but **disabled until real Apple signing and provider credentials are configured**. Unit and local database tests exercise signed requests through an injected fetch function; they do not establish physical-device delivery or production HTTP/2 transport compatibility.

## Configuration and release gate

The API Worker accepts `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID`, and `APNS_PRIVATE_KEY` (the complete PKCS#8 `.p8` key) as private environment configuration. Never commit these values or put them in browser assets. All four are required. The native app must also be signed with the matching push entitlement and environment before exposing its opt-in control. No Apple account is purchased by this implementation.

Before enabling delivery for members, test a signed sandbox build on a real device and verify the deployed Worker's HTTP/2/TLS connection, provider key/topic/environment, permission denial, token rotation, foreground handling, generic lock-screen preview, tap navigation, logout, and session revocation. Repeat with the production entitlement before distribution. App Store publication is not needed for development-device testing, but Apple signing/provisioning and APNs access are still prerequisites.

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

The only payload is:

```json
{"aps":{"alert":{"title":"Porchday","body":"You have a new update"}}}
```

No names, post IDs, comment IDs, photos, content, counts, keys, or evidence enter APNs. Tapping opens Notifications and the client fetches authorized state again. Apple necessarily sees the app topic, device delivery token, provider account, timing, and generic alert. Infrastructure stores these delivery capabilities as restricted operational metadata; they are not end-to-end encrypted social content.

The sender permits only `api.push.apple.com` and `api.sandbox.push.apple.com`, constructs the device path from validated hex, refuses redirects, uses a bounded timeout, and does not log token URLs, authorization headers, private keys, or provider response bodies. Provider errors are parsed under a 1 KiB limit and reduced to known outcome categories. `apns-expiration: 0` asks Apple not to store the alert; a fixed collapse identifier coalesces duplicate generic updates. Already in-flight or delivered alerts cannot be recalled, including the small interval between the final authorization check and send. Apple describes expiration as best effort, so no strict recall guarantee is made.

`jose` signs ES256 provider JWTs. The jobs-only database cache reuses a token for 45 minutes across Worker isolates; concurrent refreshes reuse the first stored token. This avoids minting a provider token for each notification. The `.p8` private key stays in Worker secrets. Cached JWTs are also delivery credentials: social/database API roles cannot read the cache or invoke its function; telemetry and exports exclude it. Configuration changes use a different cache key, and entries older than 24 hours are removed on cache access.

Delivery retries use bounded backoff, up to eight attempts or 24 hours. Apple 5xx responses wait at least 15 minutes; 429 honors bounded `Retry-After`. Invalid or unregistered device tokens revoke the subscription. Permanent forbidden/payload errors stop that job. Re-enrollment clears old queued work so a late failed attempt cannot revoke a fresh registration. Outbox rows are retained seven days after completion. At-least-once processing can produce a repeated generic alert after a crash; it cannot make a social write.

## Verification

Run `NATIVE_PUSH_TEST_DATABASE_URL=<disposable local postgres URL ending in porchday_native_push_test> npx vitest run apps/api/test/native-push.test.ts`. The test recreates schemas in that specifically named disposable database. It covers real ES256 verification, exact generic payload/Apple endpoints, malformed input, disabled configuration, member/session isolation, restricted raw-token access, persistent provider-token reuse/refresh, registration limits, stale leases, re-enrollment races, expiration, blocks/mutes, opt-out, deletion, and transient/permanent provider responses. All network sends are injected; none send a notification to Apple.

Primary protocol references: [Apple request format and HTTP/2 requirements](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns), [provider token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), and [APNs response handling](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns).
