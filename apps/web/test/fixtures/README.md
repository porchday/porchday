# Image fixtures

`jpeg-variants.json` contains 15 tiny, entirely synthetic four-quadrant images.
No member photos, device identifiers, location data, or recovery material are
included. The pixel dimensions are 32 × 24, except the 16 × 12 auxiliary image
appended to the container fixtures. EXIF orientation 6 rotates the primary image
to 24 × 32 when decoded.

The fixtures cover baseline, progressive, grayscale, CMYK, RGB, ICC profiles,
EXIF rotation, restart markers, trailing padding, appended images, a two-image
MPF/MPO container, XMP with an appended image, lossless, arithmetic, and 12-bit
JPEG. The XMP fixture is **not** a genuine HDR gain map and does not verify HDR
fidelity. The MPF fixture has a real two-entry index and can be independently
opened as a two-frame MPO with Pillow.

Original JPEG fixtures were generated with Pillow 12.3.0 and libjpeg-turbo 3.2.0.
Regenerate them with those tools on `PATH`:

```sh
python3 apps/web/test/fixtures/generate-jpeg-variants.py
```

SHA-256 digests in the JSON guard against accidental fixture changes. A different
encoder version may produce different bytes; review regenerated fixtures before
updating those digests.

Run actual decoder and upload-normalization checks in fresh, signed-out browser
contexts (no server account or external network required):

```sh
npx playwright install chromium webkit
node scripts/check-photo-compatibility.mjs
```

Optionally add `--output-dir artifacts/private/jpeg-normalized` to save normalized
synthetic JPEGs for checking with another decoder such as ImageIO. The directory
is created if necessary. The script does not use an existing browser profile.

The check calls the same `preparePhoto` function as the post/profile uploader,
checks orientation and representative pixels, checks normalized output with the
strict received-photo validator, and checks that original metadata and appended
images do not survive normalization. Arithmetic and 12-bit support is conditional
on the browser decoder; an unsupported browser must fail with a useful error.
The separate `webkit-canvas-png.json` fixture is used by the PNG privacy tests.
