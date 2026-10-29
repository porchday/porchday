# Hosted group invitation UI — October 29, 2026

[Evidence](group-invitation-hosted-browser-2026-10-29.json) records a fresh isolated
Chromium rehearsal against the deployed staging backend and frontend. The owner
logged in, unlocked with its synthetic recovery secret, remembered the device,
navigated to the group and decrypted its name. In Members & settings it selected
an accepted synthetic connection, submitted one invitation and observed the
recipient and inviter in the owner roster. The recipient subsequently accepted
through the API; owner roster acceptance and non-owner 403 checks passed.

All three synthetic sessions were logged out once and their cookies rejected.
The exact group/account/member/session rows were removed. Full provider inventory
and canonical state were unchanged; the shared lease was released.

The earlier navigation and picker-selector attempts remain failed and fully
reconciled. The corrected harness uses remembered-device navigation and the
combobox role/name. A local DOM test showed why an exact-label Playwright lookup
fails on this wrapped select while the accessible role/name lookup works.

This passes the scoped owner invitation workflow, not complete profile setup:
the screenshot displayed an unconfirmed initial-profile background-setup notice.
The minimal API-generated group omitted a description, and the UI retained its
Loading group fallback under the decrypted name. These observations remain
validation gaps, not evidence that all onboarding or group presentation passes.

No release occurred during this rehearsal. Already-open client overlap across
a deployment, supported native devices, scheduled feature rollout, source
alignment and production promotion remain separate requirements. In particular,
the staging branch contains older iOS files than main; do not replace main with
its whole tree to recover the deployed API compatibility floor.
