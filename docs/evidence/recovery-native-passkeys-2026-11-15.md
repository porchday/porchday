# Native recovery passkey permission — November 15, 2026

Tracks [#228](https://github.com/porchday/porchday/issues/228) and [#49](https://github.com/porchday/porchday/issues/49).

## Confirmed cause

The reported installed iOS version is 0.1.0 (424). The distributed signed IPA contains `applinks:porchday.org` and `applinks:porchday.com`, but neither `webcredentials` domain. [Apple requires an associated relying-party domain for passkeys in WKWebView](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys/). Inspection used the actual signed entitlements, not just the source file.

Recovery source added the required domains after build 424. Web deployment delivered the recovery UI to that older shell without delivering a new signed binary. Simulator/browser acceptance did not cover that distribution boundary. Production and Apple CDN association files contain the expected application identifier.

This establishes a native capability blocker. The generic `NotAllowedError` text alone does not establish which credential-manager stage failed. Provider PRF support and the full physical-device create/verify/restore flow still need verification after updating.

## Release and validation

Candidate source: `225b59014659a7bad9e525962a3a031746906887`. [Native simulator tests and signed archive](https://github.com/porchday/porchday/actions/runs/43755064476) passed: 154 unit tests with four opt-in checks skipped and no failures, plus three passing UI tests. Skipped checks are not counted as verified. Exact-source web, secret scan, iOS and macOS push CI previously passed.

The archive script now asserts both recovery domains in the signed application entitlements. The regression check rejects the actual old build 424. Independent inspection of the exported IPA verified its source/hash, signature, production provisioning, both webcredentials domains and both production/Apple-CDN association files. The initial Python HTTP client received 403; the retained signed-file checks and fresh curl requests then passed. No failed verification was treated as success.

iOS **0.1.0 (498)** was uploaded once and processed successfully. At 20:17 UTC, Apple reported `IN_BETA_TESTING`; membership in the existing internal owner TestFlight group was verified by read-back. No new tester was invited. SHA-256: `612d1f58d627d26d9f142b2aa951a09819429448ca101e7cea9eddb350b2e213`.

No web/API deployment, account reset, key replacement or storage namespace change is part of this release. Existing installed data must be retained by updating in TestFlight; do not uninstall the app.

## Remaining acceptance

Physical-device passkey creation, the separate verification prompt, and recovery after reopening remain `needs verification`. Correct entitlements do not by themselves establish provider compatibility. Older native shells still need clearer capability guidance; tracked in #228.
