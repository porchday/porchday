# Third-party software notices

Porchday's original source is licensed under Apache License 2.0. Dependencies keep their own licenses; the root license does not relicense them. The unmodified upstream license texts are in third-party-licenses. These notices describe the pinned client build, not a legal review or security audit.

| Component | Version | License | Source |
| --- | --- | --- | --- |
| Unicode Emoji data | 17.0 | Unicode-3.0 | https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt |
| OpenPGP.js | 6.3.2 | LGPL-3.0-or-later | https://github.com/openpgpjs/openpgpjs/tree/v6.3.2 |
| GopenPGP | 3.5.0 | MIT | https://github.com/ProtonMail/gopenpgp/tree/v3.5.0 |
| ProtonMail go-crypto | 1.5.2 | BSD-3-Clause | https://github.com/ProtonMail/go-crypto/tree/v1.5.2 |
| Cloudflare CIRCL | 1.6.3 | BSD-3-Clause; additional p384 notice retained | https://github.com/cloudflare/circl/tree/v1.6.3 |
| Go x/crypto | 0.41.0 | BSD-3-Clause | https://cs.opensource.google/go/x/crypto/+/v0.41.0 |
| Go x/sys | 0.49.0 | BSD-3-Clause | https://cs.opensource.google/go/x/sys/+/v0.49.0 |
| Go x/mobile bridge | 197770444867 (2026-10-11) | BSD-3-Clause | https://go.googlesource.com/mobile/+/197770444867 |
| Go runtime | 1.27.3 | BSD-3-Clause | https://go.googlesource.com/go/+/refs/tags/go1.27.3 |
| ZIPFoundation | 0.9.20 | MIT | https://github.com/weichsel/ZIPFoundation/tree/0.9.20 |
| React and React DOM | 19.3.1 | MIT | https://github.com/facebook/react/tree/v19.3.1 |
| React Scheduler | 0.28.0 | MIT | https://github.com/facebook/react |
| fflate | 0.8.3 | MIT | https://github.com/101arrowz/fflate/tree/v0.8.3 |
| node-qrcode | 1.5.4 | MIT | https://github.com/soldair/node-qrcode/tree/v1.5.4 |
| dijkstrajs | 1.0.3 | MIT | https://github.com/andrewhayward/dijkstra |

OpenPGP.js is used without Porchday changes. Its distribution includes upstream bundled dependencies; retain its source tree, lockfile, package metadata and bundled copyright/license headers when rebuilding or redistributing. The accompanying LGPL v3 text incorporates GPL v3; both full texts are included. Do not remove upstream notices or restrict permitted debugging/modification of the library.

The native bridge links GopenPGP and its Go dependencies. The native build is reproducible from packages/crypto/native/go.mod and go.sum plus apps/ios/project.yml and build-native.sh. Build tools have their own licenses and are not relicensed by Porchday. Xcode and Apple platform frameworks are supplied by Apple, not by this repository.

## Source and replacement builds

From a Porchday source checkout, install Node 24, run npm ci and npm run build --workspace @porchday/web. For a modified OpenPGP.js build, obtain the exact upstream v6.3.2 source above, follow its npm build instructions, install that local build into packages/crypto in place of openpgp, then rebuild the web client. The readable TypeScript adapter is in packages/crypto/src; no private service credentials are needed to build a replacement client.

For iOS, install the pinned Go version, full Xcode and XcodeGen, then run apps/ios/build-native.sh. A modified GopenPGP checkout can be selected using a local Go module replace directive before rebuilding the bridge. Simulator builds need no App Store account. Device distribution uses the recipient's signing identity.

scripts/package-client-source.py produces a deterministic source archive from the tracked client, build and license files for the exact release. It excludes credentials, local state and server implementation. Release distributors must make the applicable corresponding source and replacement/rebuild materials available alongside their client artifacts; this file alone is not a substitute. Keep the source archive available for the required distribution period. An inaccessible repository URL is not a substitute for source access for recipients.

Regenerate the app-visible notices with python3 scripts/build-third-party-notices.py after dependency changes. Review the lockfile and upstream bundled notices when updating versions; do not infer license compatibility from the top-level package alone.
