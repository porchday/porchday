#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
xcrun swiftc -sdk "${MACOS_SDK_PATH:-$(xcrun --sdk macosx --show-sdk-path)}" apps/macos/Sources/NavigationPolicy.swift apps/macos/Tests/main.swift -o "$tmp/test"
"$tmp/test"
