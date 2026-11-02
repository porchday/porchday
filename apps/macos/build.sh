#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
PORCHDAY_APPLE_TARGETS=macos apps/ios/build-native.sh
xcodebuild -project apps/ios/Porchday.xcodeproj -scheme PorchdayMac \
  -destination 'generic/platform=macOS' -derivedDataPath apps/ios/build/Mac build
