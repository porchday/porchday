#!/bin/bash
set -euo pipefail
task_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$task_root/packages/crypto/native"
go install golang.org/x/mobile/cmd/gobind
export PATH="$(go env GOPATH)/bin:$PATH"
mkdir -p build
go tool gomobile bind -target=ios,iossimulator -iosversion=17.0 -o build/Porchcrypto.xcframework .
cd "$task_root/apps/ios"
xcodegen generate
