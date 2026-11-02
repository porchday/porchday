#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
root="$PWD"
out="$root/apps/macos/build"
version="$(cat apps/macos/VERSION)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid VERSION'; exit 1; }
mkdir -p "$out"
stage="$(mktemp -d "$out/stage.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
app="$stage/Porchday.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
sdk="${MACOS_SDK_PATH:-$(xcrun --sdk macosx --show-sdk-path)}"
for arch in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -O -sdk "$sdk" -target "$arch-apple-macosx13.0" \
    -framework AppKit -framework WebKit apps/macos/Sources/*.swift -o "$stage/Porchday-$arch"
done
lipo -create "$stage/Porchday-arm64" "$stage/Porchday-x86_64" -output "$app/Contents/MacOS/Porchday"
mkdir "$stage/AppIcon.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" apps/web/public/icon-1024.png --out "$stage/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" apps/web/public/icon-1024.png --out "$stage/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$stage/AppIcon.iconset" -o "$app/Contents/Resources/AppIcon.icns"
cp LICENSE "$app/Contents/Resources/LICENSE.txt"
cp THIRD_PARTY_NOTICES.md "$app/Contents/Resources/THIRD_PARTY_NOTICES.md"
python3 - "$app/Contents/Info.plist" "$version" <<'PY'
import plistlib,sys
with open(sys.argv[1],'wb') as f:
 plistlib.dump(dict(CFBundleIdentifier='org.porchday.macos',CFBundleName='Porchday',CFBundleDisplayName='Porchday',CFBundleExecutable='Porchday',CFBundlePackageType='APPL',CFBundleShortVersionString=sys.argv[2],CFBundleVersion='1',CFBundleIconFile='AppIcon',LSMinimumSystemVersion='13.0',NSHighResolutionCapable=True,NSPrincipalClass='NSApplication',NSHumanReadableCopyright='Porchday contributors. Apache-2.0.'),f)
PY
codesign --force --sign - "$app"
codesign --verify --deep --strict "$app"
# Replace only this script's build products; no installed application is touched.
rm -rf "$out/Porchday.app"
mv "$app" "$out/Porchday.app"
archive="$out/Porchday-${version}-macOS-universal.zip"
rm -f "$archive"
ditto -c -k --sequesterRsrc --keepParent "$out/Porchday.app" "$archive"
(cd "$out" && shasum -a 256 "$(basename "$archive")" > SHA256SUMS.txt)
echo "Built $archive (Apple silicon + Intel, macOS 13+; ad-hoc signed, not notarized)."
