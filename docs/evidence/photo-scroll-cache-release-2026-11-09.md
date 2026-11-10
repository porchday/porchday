# Stable photo scrolling and memory cache — November 9, 2026

Implemented in [PR #215](https://github.com/porchday/porchday/pull/215), tracked in [#168](https://github.com/porchday/porchday/issues/168). The shared web/PWA interface and default iOS/macOS web shells receive the same photo fixes. No new native binary is required or claimed.

## Live release

Reviewed application/asset source: `8625135d0caaf57729503f98b01333408314f774`.

| Environment | Active edge/UI version | Rollback version with retained assets |
| --- | --- | --- |
| Staging | `8dfb8e37-68cd-46b4-8fa0-030ff4465b8f` | `b44f0e50-9f57-49ef-9e46-10ed0aec4709` |
| Production | `7e3bd27d-1ee6-4f32-afc2-47f19ae5de94` | `352355dd-e449-40b2-9bf7-76bcd9b9b4fa` |

Production activated at 07:00 UTC November 10 (November 9 Pacific). API versions, journal behavior and database schemas were unchanged. Activation used the maintained native-parity-gated release tooling at `cce72b4ce5e486b5413ffa0b7cac43dadcb471e6`.

## Behavior

- Signed dimensions reserve the image frame before download/decode; captions and tags already occupy their final space. Calendar cropping and profile cover/avatar sizing remain explicit.
- Equivalent photo and album-cover records retain opened content. Unchanged nearby images remain mounted through refreshes.
- Verified decrypted photo blobs use a memory-only LRU cache with a 48 MiB estimated budget and 96-entry cap. Accounting includes blob bytes, identity strings and estimated decoded pixels; this is not a total browser-process RAM limit. Entries expire after two minutes or the signed content deadline, whichever comes first, with proactive cleanup.
- Photos within 400px above/below the viewport preload with at most three concurrent jobs and visible work prioritized. Far-offscreen object URLs are released. The observer fallback also remains bounded instead of downloading the whole feed.
- A warm cache consumer reauthorizes through authenticated HEAD on the existing media route before using cached bytes. A miss uses authenticated GET and verifies/decrypts/validates the photo. Cached bytes are never an authorization decision.
- Expiry, relevant access/content writes, account/device/key scope changes, logout and backgrounding invalidate or remove photos. Late invalidated results are rejected. Comments and reactions do not unnecessarily clear unchanged photos. Video playback/access behavior is unchanged.

## Validation

Exact release-source checks passed before production:

- [Full CI, including database-backed tests](https://github.com/porchday/porchday/actions/runs/42770025776).
- [Browser feed/detail/save regressions](https://github.com/porchday/porchday/actions/runs/42770025773).
- [iOS simulator build/tests](https://github.com/porchday/porchday/actions/runs/42770026191) and [macOS build/tests](https://github.com/porchday/porchday/actions/runs/42770026077).
- [Secret scan](https://github.com/porchday/porchday/actions/runs/42770025760).

Local application suite: 1,358 passed, 327 environment-dependent skips; the final follow-up only corrected a synthetic browser fixture. Focused cache/surface/identity tests: 16 passed. Chromium and WebKit at phone and desktop widths verified zero reading-anchor movement after delayed decode, stable image DOM identity for equivalent records, warm scroll with no extra byte GET, denial, account switching and expiry. Additional feed/save/navigation, observer fallback, post-detail and album-adoption browser checks passed.

Hosted staging and production each published a real encrypted synthetic photo, scrolled away/back, and verified **zero new photo byte GETs**, fresh successful HEAD authorization, anonymous HEAD denial and unchanged frame height. Existing encrypted-draft restore, safe automatic updates, deletion failure/retry, settings/diagnostics consent, native-bridge smoke, deployed asset identity and domain routing checks also passed. These are synthetic-account checks, not measurements on an owner's physical phone.

Staging rollback/candidate continuity: 13/12 samples, zero failures. Production rollback/candidate continuity: 17/17 samples, zero failures. All activation and hosted acceptance fixtures were cleaned up with zero remaining fixture rows. Existing-tab forward and rollback asset checks passed.

The staging activation preparation initially refused a local evidence file with overly broad permissions; it was changed to owner-only access, the incomplete preparation was archived, and preparation was repeated before activation. No duplicate upload or uncertain activation was replayed. Earlier synthetic fixture assumptions were corrected without weakening the scrolling/access assertions.

## Remaining verification

Keep #168 open with `needs verification` for physical iPhone/Mac scrolling with representative photos, longer sessions and memory pressure. No physical-device frame-time improvement, universal instantaneous loading, or total-process memory cap is claimed. Cache eviction, expiry and required access checks can still require loading; slow arrival no longer changes the reserved image geometry. Native device/distribution follow-ups remain under #49/#114.
