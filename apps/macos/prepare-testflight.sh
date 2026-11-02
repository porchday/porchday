#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
command -v xcodegen >/dev/null || { echo 'Install XcodeGen first.' >&2; exit 1; }
# Reuse only generated icon/license resources, never the preview executable/signature.
apps/macos/build.sh
xcodegen generate --spec apps/macos/project.yml
printf '%s\n' 'Generated apps/macos/PorchdayMac.xcodeproj. Select your Apple team in Xcode before archiving.'
