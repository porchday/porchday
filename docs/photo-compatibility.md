# Photo import compatibility

Tracked in [issue #24](https://github.com/porchday/porchday/issues/24). The original member photo that triggered the report has not been supplied; the synthetic regression fixtures establish specific compatibility defects, not its exact encoding.

## Import and shared content

Web/PWA photo import identifies JPEG, PNG and WebP from their bytes rather than trusting a filename or MIME label. JPEG aliases such as `.jfif`, `image/pjpeg`, `image/jpg` and empty MIME labels can therefore use the same import path. Post, profile and group photo pickers share the preparer; custom emoji import uses the same JPEG source preflight with its own smaller limits.

A camera original may contain more than the single image that Porchday shares. The source preflight checks the primary JPEG frame dimensions before decoding, isolates its complete image, and removes the MPF directory that would otherwise refer to discarded auxiliary images. EXIF orientation and color profiles remain available to the local browser decoder. The decoded pixels are resized, rendered into sRGB and encoded as a single JPEG with metadata removed, before encryption. Originals are never sent unencrypted to a conversion service. Custom emoji become the existing bounded, static PNG format.

Source photos can be **50 MB or smaller** (an inclusive 50 MiB / 52,428,800-byte limit) and remain limited to 40 million pixels; output has a maximum dimension of 2400 pixels. This applies to post, profile and group photo imports. Custom emoji sources remain limited to 5 MiB and 16 million pixels. Malformed, truncated, hierarchical or deferred-dimension JPEGs are rejected rather than sent through an unbounded decode. Received photos and archive content continue to require a complete, bounded, single JPEG of at most 20 MiB; the larger source allowance does not increase normalized image or archive-part limits.

## Format coverage and limits

The synthetic corpus includes baseline, progressive, grayscale, CMYK, RGB, EXIF rotation, ICC profiles, restart markers, trailing padding, appended auxiliary images, a genuine two-entry MPF/MPO container, lossless, arithmetic and 12-bit JPEGs. See the [fixture provenance and regeneration instructions](../apps/web/test/fixtures/README.md). The XMP-plus-appended-image fixture tests container handling; it is not evidence of HDR gain-map fidelity. Import retains the primary image, not additional frames, depth information or HDR gain maps.

Decoding still depends on the browser or operating system. An encoding unsupported by that decoder produces a clear request to export a standard JPEG or PNG. This is broader JPEG support, not a claim that every JPEG standard, damaged file or extension is readable on every device. The native iOS uploader already uses ImageIO's primary-image decode, orientation transform and JPEG re-encoding; it does not require the web source-parser change.

## Validation

Run `node scripts/check-photo-compatibility.mjs` after installing Playwright Chromium and WebKit. It uses generated images in fresh signed-out browser contexts and calls the production photo preparer. Unit tests cover source bounds, malformed data, MIME/signature handling and the strict received-image boundary. Real-browser checks cover decoding, orientation, colors and normalization. Release evidence and the separate retry of the originally reported member photo belong in issue #24; synthetic checks do not establish that owner's acceptance.

The initial matrix passed on Chromium 156.0.8078.4 and WebKit 27.2. Chromium normalized 13 of the 15 fixtures, including lossless JPEG, and returned the expected useful error for arithmetic and 12-bit JPEGs that its decoder could not read. WebKit normalized all 15. Both engines passed the MIME-alias, thumbnail, custom-emoji and pre-decode size checks. All 28 normalized photos also decoded and rendered as one image with the expected dimensions through macOS ImageIO; this is an interoperability check, not a physical iOS device test. The full web unit suite passed 199 tests.
