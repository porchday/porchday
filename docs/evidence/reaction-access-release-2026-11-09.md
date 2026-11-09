# Reaction attribution and photo access — November 9, 2026

[PR #202](https://github.com/porchday/porchday/pull/202) is merged and deployed to staging and production. Tracks #201 and the #22 photo-history follow-up.

## Changes and cause

Production consented diagnostics recorded `RECIPIENT_KEYS_PENDING` at `photo.encrypt_media` and its enclosing preparation. The old client and API rejected the entire original-photo history refresh when one eligible person lacked keys. Ready recipients can now receive access while pending eligible people return to the server-computed catch-up queue after key setup. Existing audience, epoch, signature and revision checks remain; album rules are unchanged. This confirms a production failure mode, not a retrospective match to the owner's exact screenshot/device.

The worker also retains unprocessed page entries before fetching another page. Previously its three-operation budget could drop the last two entries of a five-photo page until another scan. Both non-actionable access banners are removed; automatic retries and consented diagnostics remain.

Post, comment and photo reactions now offer long-press, right-click and a keyboard-accessible View reactions control. Validated decrypted reactions are grouped by emoji with authorized handles and avatars. Ordinary taps still toggle reactions; photo pagination remains available.

## Deployed sources

- Shared UI: `a9bf88845bad31ff4826ac0f7fd5d36ed58326c2`.
- Staging API: `4474062837b36ed1e33bd8c7e3f45cbe3d4dc777`; Worker `3d34c70a-0721-450e-90be-6ef23a61032d`.
- Production API: `4d230fc96af750f168c1b21a20d71f6813d7847e`; Worker `faa0234e-8165-4eda-9d62-7f013f24ff57`.
- Staging UI Worker: `53bc3644-d15a-40ba-8293-0a1cdfe03090`.
- Production UI Worker: `77104df6-b336-41cd-aa1b-b4e00ebcc164`.

Environment-specific API runtime and its matching baseline tests were retained, with the new feature regressions applied. Initial candidate CI exposed a baseline test/runtime mismatch; those candidates were not deployed. Corrected exact-source application, secret-scan, iOS and macOS checks passed. No schema migration or native binary change was required.

## Verification

- Workspace typechecks; Chromium/WebKit reaction inspection and save/retry regressions; photo conversation browser checks; 22 focused worker/history/photo-helper tests.
- 20 real-encryption photo HTTP tests passed against both full and preserved production schemas.
- Hosted staging and production: ready recipient decrypts original photo metadata and actual media while another eligible person lacks keys. The photo re-enters catch-up when that person's key appears.
- Injected post 503 and failed photo read recover automatically; lost successful responses reconcile without duplicate writes. No retry banner/button; navigation remains usable.
- A newly recovered own device performs zero redundant post/photo/media refresh writes. Photo dates and original post date remain unchanged.
- Deployed reaction picker saves a reaction, long-press shows its authorized handle, and inspection leaves the saved reaction unchanged.
- Draft persistence, automatic updates, login/logout continuity, revoked-session denial, legacy redirects, native shell and encrypted notification compatibility passed.
- Production monitoring: 8 samples over 140017 ms, zero failed samples, covering protected readiness, authenticated feed/profile, anonymous sessions, login/logout and revocation.
- Synthetic test records cleaned up in both environments. Private manifests, receipts and detailed evidence remain in the restricted release archive.

Physical iPhone/macOS gesture acceptance and the owner's specific historical-sharing scenario remain follow-ups in #201/#22. Current thin-shell apps receive this shared UI update without a new TestFlight binary; no new native binary was distributed by this release.
