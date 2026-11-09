# Encrypted notification content previews

Requested by the operator after #7's author/activity-only previews. Show the author,
a short post/caption excerpt and a photo thumbnail where supported. Notifications
remain opt-in; preview controls belong in Settings → Notifications. Opening a
notification must open the referenced item. Old clients keep the generic fallback.

## Delivery and confidentiality

The author prepares one bounded preview (up to 240 text characters and a small JPEG
thumbnail). Encrypt it with a random AES-GCM content key, then wrap that key for
registered notification-preview keys belonging to the existing encrypted audience.
Each preview key is signed by its owner's existing encryption device; authors
verify that authorization before using it. Notification keys are separate from
account/recovery keys. Neither those keys nor plaintext content crosses the native
web bridge or reaches the server/APNs payload.

Store ciphertext and wrapped keys with the original publication. Only registered
subscriptions for recipients already authorized for that post/photo can obtain a
short-lived, notification-scoped retrieval token. Retrieval rechecks session and
device revocation, subscription enrollment, current content access, deletion,
expiry, blocks and mutes. Previews never expand an audience. Edits invalidate old
previews. Keep APNs below its payload limit by sending only a retrieval reference.

The receiving device decrypts locally. PWA service workers keep notification keys
in IndexedDB; native service extensions use shared, device-only Keychain storage.
The native bridge exposes only preview public keys and cleanup commands. On timeout,
missing key, denied access or unsupported client, use the existing generic notice.
Do not block publishing because a recipient has no preview key.

The OS controls lock-screen visibility; already displayed previews cannot be
recalled reliably. Explain that in notification settings. Browsers that do not
render notification images still show the excerpt. Native support requires a signed
app update embedding an iOS/macOS notification service extension.

## Acceptance

- Text-only posts, captioned photos, image posts and video poster fallbacks.
- Author signatures, recipient bindings, ciphertext integrity and expiry validated.
- No plaintext in server storage, push payloads, logs or delivery errors.
- Block/mute/disconnect, deletion, edit, sign-out and revocation deny stale retrieval.
- Generic fallback remains visible and badge counts remain correct on any failure.
- Background PWA and native extension interoperability, bounded resource use,
  native signing/packaging, deep links and cleanup tested.
- Stage, then production using the maintained release gates; distinguish deployed
  server/web support from distributed native binaries and device verification.


Author trust uses the existing pinned device fingerprints, copied as public metadata to the notification store during active app use. A never-seen author/device falls back to the generic alert until verified in the app. The server cannot supply a replacement signing key silently. New notification keys only receive previews of subsequent publications; this is not a history backfill.
