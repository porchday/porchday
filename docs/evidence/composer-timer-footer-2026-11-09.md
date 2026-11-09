# Composer timer footer — November 9, 2026

[PR #210](https://github.com/porchday/porchday/pull/210), source `b3b5bbc68651a971c4d220dff1bb7e0292cc6258`, follows up [#207](https://github.com/porchday/porchday/issues/207).

The timer now sits in the bottom action area with Share, below media and audience controls. Preset and custom expiration controls remain disabled while saving, importing or restoring a draft. The informational note about people still setting up sharing is removed; sharing/encryption behavior is unchanged.

- Web typecheck/build and existing Chromium/WebKit draft recovery/publication checks passed.
- Local phone/desktop inspection verified the footer location, absent note, working preset/custom input and no horizontal overflow.
- Exact-source push CI passed: Verify Porchday 42714936558; Secret scan 42714936565; iOS 42714936507; macOS 42714936828; post-detail browser checks 42714936547; invitation browser checks 42714936506; reaction save checks 42714936750.
- Hosted staging and production checked the timer in the footer, its absence from media tools, removal of the setup note, responsive layout, draft restore/discard, encrypted publication and immediate Feed handoff, deletion feedback, settings and diagnostics.
- Old-tab/fresh-client asset transition and rollback compatibility, protected reads/denials, native-shell routes and redirect checks passed. Final provider inventory matches canonical deployment; no active lease remains and synthetic fixtures were removed.
- Staging UI: `4f5a688d-47e9-464e-a8e0-b25f8460f748`. Production UI: `8b3468fc-c3c0-4316-83a2-329742bfa74b`. API workers/schema are unchanged.
- 8 production monitor samples over 140010 ms, with 0 failed samples.

The shared web UI carries this change to PWA/iOS/macOS shells without another native binary. Actual physical-device acceptance remains follow-up in #207 and was not claimed as performed.
