# Navigation order release — November 4, 2026

The web sidebar now starts Feed, Share, Albums, Connections, More, matching mobile. Groups, Notifications, My wall, Feature additions and Settings follow. Feature additions uses a code icon; its existing sidebar access gate is preserved. Builder chat remains accessible through More. Suspended members still receive Settings-only navigation.

Implementation: [PR #148](https://github.com/porchday/porchday/pull/148), source `99ce3459255e3e86f891f16ee7ce6df8b192f6d6`, merged as `dd30b2bc1be45801ceb0f68cdcc340f1d47e445e`.

| Environment | Frontend version | API version (unchanged) |
| --- | --- | --- |
| Staging | `2886fb30-d94b-4b98-b865-93927056a928` | `dd09a39a-64e5-4614-81c4-4e01a596fc51` |
| Production | `9b81ad05-768a-4afd-ae67-3a2ec9e9cdf2` | `be4bea80-9d70-44d7-8298-fbd197337f69` |

## Verification

- Exact-source [main verification](https://github.com/porchday/porchday/actions/runs/41909071252), secret scans and browser workflows passed. Web production build, formatting and diff checks passed locally.
- Browser checks rendered the actual AppShell at 390 and 1200 pixels with allowed, ordinary and suspended-member fixtures: primary/secondary order, More active state, Builder chat access, code icon, and no horizontal overflow passed.
- Both environments passed hosted sidebar/More navigation checks, default mixed Feed and filters, calendar, photo decryption, album access boundaries, and adding existing photos with automatic modal completion. Synthetic fixtures were removed.
- Login gates, root routes, old bookmarks, stable PWA identity and launch passed. Production domain redirects, fragments and legacy installed service worker navigation passed.
- Retained immutable assets passed old-tab/fresh-client and rollback checks. Rollback-ready and candidate activations passed authenticated/revoked-session continuity with zero failed samples. No schema changes; final provider inventory and schema audit passed.
- Post-activation production monitoring passed eight healthy observations over 140,013 ms, with zero failures, through 21:01:26 UTC. Final monitoring acceptance recorded at 21:01:42 UTC.

## Native scope

The native Mac sidebar mirrors native mobile destinations, adds More and Notifications, and uses a code icon for Feature additions. Its existing Photos calendar remains Photos; native Albums parity is separate. Native [macOS build/tests](https://github.com/porchday/porchday/actions/runs/41909094829) and [iOS simulator verification](https://github.com/porchday/porchday/actions/runs/41909071557) passed.

This deployment updates the website and installed Chrome/PWA clients. It does not distribute a new native binary. Signing, device acceptance and native distribution remain tracked in #49 and #114; no App Store or TestFlight publication is claimed.

Private release receipts and synthetic screenshots are retained under `navigation-order-release-20261104`; credentials and member data are excluded from this document.
