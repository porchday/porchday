# Encrypted Share draft autosave

Released November 8, 2026. [PR #188](https://github.com/porchday/porchday/pull/188), [issue #187](https://github.com/porchday/porchday/issues/187). [Design](../../design/post-draft-autosave.md).

Share retains its composer across signed-in tab navigation and autosaves an encrypted draft on this device. Text, attachments, original dates, captions, tags, posting identity, audience, expiry and Share mode/album selection restore after reload and unlocking. Inline feedback distinguishes saving, saved, restored and failed storage. Discard confirms before clearing. Confirmed publication clears the draft; failed posting retains it. Autosave never publishes a post.

Only signed/encrypted metadata and authenticated encrypted media chunks are persisted. Revision checks prevent silent cross-tab overwrites, serialized saves prevent stale resurrection, and publication markers reconcile interrupted responses before restoration. Storage failures retain editable in-memory content and show retry. Ordinary text/photo publication no longer reports a video-filesystem cleanup failure after a successful post in WebKit.

This release changes only the shared frontend. The existing environment-specific APIs, schema and native bridges remain unchanged. Existing default iOS/macOS web shells receive the UI without a new binary; iOS 247 and macOS 236 remain available. The optional previous Swift interface is unchanged.

## Deployed versions

| Environment | Component | Source | Version |
| --- | --- | --- | --- |
| staging | API | `5fec1df4607f2e27a22911cdda8e3764f5ece4aa` | `3dfee2ef-e5ea-4493-9b6d-b42642313ba7` |
| staging | Frontend | `0b53183ee2120ac035ef2a1be4b1aa421ea253c7` | `51e0c1e1-c7cc-45df-b0fa-3568582c0de3` |
| production | API | `4c2c85d9fd97a74b1f50aaa56248d3b15985f0a4` | `f1385fc2-c8b7-4087-ba21-ea4efaa50098` |
| production | Frontend | `0b53183ee2120ac035ef2a1be4b1aa421ea253c7` | `1b8024a1-096f-4a3e-a954-9e5c50a1ce30` |

## Verification

- Typechecks and 331 web tests passed. Chromium and WebKit exercised encrypted draft recovery, failed/successful publishing, explicit discard, storage failure/retry, multi-chunk attachments, account isolation and competing-tab revision protection. Full Chromium calendar/composer and Chromium/WebKit feed-save regressions passed.
- Exact-source web, secret-scan, iOS simulator, macOS and supporting browser workflows passed:
  - [Verify Porchday](https://github.com/porchday/porchday/actions/runs/42526583126)
  - [Secret scan](https://github.com/porchday/porchday/actions/runs/42526583251)
  - [Verify native iOS](https://github.com/porchday/porchday/actions/runs/42526583132)
  - [Verify native macOS](https://github.com/porchday/porchday/actions/runs/42526583670)
  - [Post detail browser checks](https://github.com/porchday/porchday/actions/runs/42526583280)
  - [Verify reaction save feedback](https://github.com/porchday/porchday/actions/runs/42526583350)
  - [Verify invitation connections browser](https://github.com/porchday/porchday/actions/runs/42526583205)
- Actual deployed staging and production UI tests used isolated accounts. Tab switching and reload preserved text, a photo, date, caption and Only me audience. Autosave created no post; explicit sharing created one post and cleared the saved draft. Discard remained empty after reload. Test posts/accounts were removed and fixture checks returned zero remaining rows.
- Authenticated continuity, revoked-session denial, native-bridge smoke, canonical routes, exact deployed asset hashes, and old/new open-tab forward/rollback compatibility passed.
- Final audit: `2026-11-08T22:03:54.003Z`. Production monitoring observed 8 samples over 140013 ms with zero failures.

Drafts are local to this device/account, not cross-device backups. Clearing browser/app data or OS storage eviction can remove them. Physical app termination timing and storage eviction remain follow-up checks in #49 and #114; hosted browser tests are not physical WKWebView acceptance. Existing tabs must load the new bundle before using autosave; preserve any unsent draft in an older tab before reloading it.
