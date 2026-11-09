# Visible Settings tabs and separate Notifications

Released November 8, 2026. [PR #192](https://github.com/porchday/porchday/pull/192), owner follow-up to [#124](https://github.com/porchday/porchday/issues/124).

Settings navigation wraps into visible rows instead of hiding destinations in a horizontal scroller. All six links remain visible with at least 44 px target height. Notifications has its own settings destination at `/settings/notifications`; it retains existing in-app preferences and device push controls. Time zone is under My profile. Privacy & safety retains mute/block/report controls. Preference payloads, timezone storage, permissions and API/schema behavior are unchanged.

The shared UI is used by web/PWA and default iOS/macOS shells. Available binaries remain iOS 247 and macOS 255; no new binary is required. Existing quiet automatic updates apply this frontend when safe.

## Verification

- Web typecheck/build and 338 tests passed. Browser checks verified all six destinations, wrapping without overflow at 320/390/588/1280 px, 44 px targets, Notifications/Time zone placement and persisted timezone selection. The mobile screenshot was visually reviewed.
- Exact-source web, secret scan, iOS simulator and macOS checks passed; production native parity was enforced.
- Actual staging and production checks verified wrapped settings navigation, separate Notifications, privacy/safety controls and Time zone under My profile with the selection preserved. Encrypted draft navigation/reload and safe automatic updates also passed. Synthetic content/accounts were removed.
- Canonical routes, native-shell bridge, authorized continuity and revocation, asset hashes and open-tab forward/rollback compatibility passed. Legacy URL cases were isolated into fresh pages after the reused-page fixture retained the earlier URL; application redirect code is unchanged.

Physical-device visual/lifecycle checks remain follow-up under #49/#114; hosted browser checks do not claim physical-device verification.

Exact-source checks: [web](https://github.com/porchday/porchday/actions/runs/42542024549), [PR](https://github.com/porchday/porchday/actions/runs/42542029265), [iOS](https://github.com/porchday/porchday/actions/runs/42542024726), [macOS](https://github.com/porchday/porchday/actions/runs/42542024692).

## Deployed versions

| Environment | Component | Source | Version |
| --- | --- | --- | --- |
| staging | API (unchanged) | `5d327fd0f430787904516a31dc8623abc2943096` | `2427e972-e02e-47f2-9933-ee524b546863` |
| staging | Frontend | `82522cc7d14da9c54879342f4cfb6a02b768a462` | `ec25e365-5f12-438d-8fbf-c94feea0df5c` |
| production | API (unchanged) | `822a4c4d1f650cdfde0051094b2cc73bb0c721dc` | `b34440db-f806-44e1-8298-34f9c7ea5cef` |
| production | Frontend | `82522cc7d14da9c54879342f4cfb6a02b768a462` | `fb0c9a07-c658-43ce-9dec-b268809c65d4` |

Final audit passed at `2026-11-09T01:06:58.269Z`. Production monitoring observed 8 samples over 140008 ms with zero failures. Provider state matched the canonical record, schema fingerprints were unchanged, and no synthetic fixture rows remained.
