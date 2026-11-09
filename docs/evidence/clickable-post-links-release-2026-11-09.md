# Clickable post links — November 9, 2026

[PR #204](https://github.com/porchday/porchday/pull/204) is merged and deployed. Tracks [#203](https://github.com/porchday/porchday/issues/203).

HTTP/HTTPS and www links in new and existing post text are clickable. React renders safe anchors without interpreting HTML, preserves text and punctuation, and opens browser links separately with noopener/noreferrer. Existing native WebShell delegates open external links in the system browser and preserve Porchday's web view. No schema, encryption, API runtime or native binary change was required.

## Release

- Shared UI source: `d8a2ae37da4c7078d5a7019d32683a1da7208d6f`.
- Staging UI Worker: `0655be02-2684-4545-b308-f0ff3b9836ed`.
- Production UI Worker: `6ab5d735-18e1-4470-819e-f4693fda8a32`.
- Existing backend versions remain as recorded in the [reaction/access release](reaction-access-release-2026-11-09.md).
- Maintained activation tooling: `cce72b4ce5e486b5413ffa0b7cac43dadcb471e6`, including enforced exact-source native parity.

## Validation

- Four tokenizer tests cover whitespace, punctuation, balanced parentheses/IPv6, Unicode, multiple links and unsafe schemes. Workspace typechecks pass.
- Chromium and WebKit exercise real React rendering, safe external link activation, keyboard focus, null opener and preserved source page.
- Exact-source push CI passed: Verify Porchday 42651002118, Secret scan 42651001893, iOS 42651002055 and macOS 42651002404.
- Release-tool CI passed: Verify Porchday 42655333858 and Secret scan 42655333919. Twenty-one focused asset/verifier tests also pass on current main.
- Hosted staging and production publish an encrypted synthetic post, verify two anchors and exact punctuation, and click a link into a separately opened intercepted synthetic destination. Porchday stays on the post page. No real external site receives the fixture.
- Forward/rollback assets, open-tab/fresh-client transitions, shared-shell routing, legacy redirects, draft restoration, quiet automatic updates, settings and diagnostic consent checks pass.
- Authenticated activation continuity: zero failed samples in both environments. Production monitoring passes eight samples across approximately 140 seconds.
- Final provider inventory matches the canonical verified deployment, with no active deployment lease. All synthetic fixtures are cleaned up.

## Asset convergence investigation

Two initial staging attempts were safely rolled back: newly uploaded JS/CSS URLs intermittently returned HTTP 200 HTML while other assets were already correct. The verifier's three rounds were separated by only 250 ms and 750 ms. The bounded read-only settling delays are now 10 and 20 seconds; every round still validates all MIME types and exact hashes, records failures, respects cancellation, and rolls back on persistent failure. Login/logout is never replayed by these retries.

On the successful production rollback-ready activation, round 1 observed HTML at the new CSS URL at 16:43:01 UTC; round 2 verified every asset at 16:43:13 UTC. This confirms transient delivery convergence and validates the retry handling. It does not identify Cloudflare's internal cache/propagation mechanism. [#3](https://github.com/porchday/porchday/issues/3) retains the broader investigation. Restricted v2/v3 failure archives and v4 release receipts preserve the detailed evidence.

Physical iPhone/macOS external-browser handoff remains a follow-up in #203. No physical-device check or new signed native build is claimed. Existing thin-shell apps receive this shared web UI update.
