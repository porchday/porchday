# Unified media selection release — November 8, 2026

Implemented in [PR #184](https://github.com/porchday/porchday/pull/184), tracked in [#183](https://github.com/porchday/porchday/issues/183).

One **Add photos/videos** control opens the system mixed-media picker. iOS/WebKit supplies the Photos selection UI; its exact grid/zoom/count controls depend on the OS version. Selected videos enter preparation sequentially without cropping or trimming. The button label remains visible on narrow screens.

New photos use original embedded capture dates before image normalization, preserving the recorded calendar day rather than converting it to the viewer’s timezone. Missing dates require an explicit choice; upload time and filesystem modification time are not substituted. Suggested dates remain editable, and posts retain publication-time dates.

## Deployed versions

| Environment | Component | Source | Version |
| --- | --- | --- | --- |
| staging | API | `2dc9f19c434db2c63c3fdca007143b60ce5548b5` | `9e341564-04a3-4d2e-b3ba-834a9fca1b1d` |
| staging | Frontend | `365d3ed8772f6cbbd1b458a03876b69b7e7d9494` | `ca062b26-2e74-4490-bb00-f32feb719e8e` |
| production | API | `1927c4bf3b7f0277b4b27ffd5689bdbfd8e72dbb` | `08a78a93-14f8-4d37-a66d-725861ad1885` |
| production | Frontend | `365d3ed8772f6cbbd1b458a03876b69b7e7d9494` | `2d8f78c6-d28c-4d46-9328-d2dcd69ec518` |

No API or schema change was required. Existing API sources and compatibility floors were preserved. The feature source is `365d3ed8772f6cbbd1b458a03876b69b7e7d9494`; merge commit `9a28c9e383682d5df6c445c904c048c1d685a528` includes it on main.

## Automated and hosted verification

- Workspace type checks and 331 web tests passed, including real EXIF bytes, timezone boundaries, invalid dates and missing metadata.
- Chromium verified mixed-media picker wiring, visible labels, date defaults/edits across Share modes, required missing dates, video cancellation and full-duration preparation at mobile and desktop widths.
- The shared-inbox browser check verified explicit import, file-backed byte transfer, acknowledgement after successful import, and rejection of truncated chunks without discarding the native source.
- Native macOS tests cover TIFF-to-JPEG conversion retaining DateTimeOriginal and stripping location metadata, plus inbox identifier boundaries.
- Retained assets passed old-tab forward and rollback checks. Staging and production authenticated continuity, revoked-session denial, login/routes, exact frontend assets, simulated-shell smoke and synthetic-fixture cleanup passed.
- Final production monitoring: 8 samples over 140009 ms, zero failed samples. Final audit passed at `2026-11-08T20:45:24.755Z`.

Exact-source CI:

- [Web/API](https://github.com/porchday/porchday/actions/runs/42519591345)
- [iOS simulator](https://github.com/porchday/porchday/actions/runs/42519591313)
- [macOS](https://github.com/porchday/porchday/actions/runs/42519591420)
- [Secret scan](https://github.com/porchday/porchday/actions/runs/42519591378)

## Native distribution

**macOS 0.1.0 (236)** is valid in App Store Connect, in internal beta testing, and assigned to the existing owner TestFlight group. [Signed build](https://github.com/porchday/porchday/actions/runs/42519502912) source is `d91955b84dec272e7bf5a1912d9f2123255a4b4f`; its iOS/macOS source trees exactly match the deployed frontend source. The final frontend-only follow-up expires abandoned local import files.

The package signature and embedded `org.porchday.app.share` extension were verified. App and extension use the same private app group; the extension has no network entitlement. The extension copies up to ten photos/videos into a local inbox, converts HEIC/TIFF and other ImageIO-supported image types to JPEG when needed, and retains original EXIF dates. Open Porchday → Share to import the waiting selection, choose an audience, and publish. Sharing from Photos never publishes automatically.

The extension requires installing build 236. The unified picker and date behavior use the hosted UI and also reach existing web-shell builds. iOS 0.1.0 (247) is unchanged; no new iOS binary is needed for this web change.

## Remaining verification

Actual iPhone Photos grid/zoom/count behavior and the installed macOS Photos Share-menu handoff remain physical-device acceptance under #183 (`needs verification`). Compilation, synthetic/browser checks and TestFlight availability are not claimed as physical-device verification. These checks do not block web production deployment.

[Design](../../design/unified-media-picker.md).
