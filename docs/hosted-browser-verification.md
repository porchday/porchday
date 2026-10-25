# Hosted browser acceptance

On October 25, 2026 at 18:02:56 UTC, `scripts/hosted-browser.ts session --attempt=f8910aac` passed against staging release `dd855f34-2dea-45ae-91f1-0cb112cd1d15` (application commit `e1679d7`). It used Chromium 156.0.8078.4 through Playwright 1.64.1 on macOS in a dedicated private test profile. It did not attach to the owner's browser, inject authentication state, mock a response, or read an inbox token. Test account A was already verified through a delivered email.

## Observed results

- The normal email/password form opened `/app` by default. Entering the original encryption recovery secret authorized a new browser device through the ordinary recovery flow. The browser decrypted the exact existing web-to-native interoperability post text.
- Explicitly choosing to remember the private device stored two wrapped device keys (current and historical) in IndexedDB. Both used nonextractable wrapping keys; stored rows contained ciphertext and no recovery-secret or plaintext-private-key fields. A subsequent online reload reopened the feed without entering the secret again.
- Desktop and 375-pixel-wide feed layouts rendered without horizontal overflow. Screenshots show the actual synthetic content and tiled design. Photos were still opening when captured; these screenshots do **not** establish completed browser photo decryption or a full accessibility review.
- The controlling service worker retained one cache containing 16 public shell/assets. No API/private-content URLs or query-bearing cache entries were present. Authenticated cold navigation offline displayed the offline explanation and no member feed.
- Normal UI signout cleared all remembered key rows. Replaying the previously captured cookie against both the member API and auth session endpoint proved server-side session revocation. A fresh online `/app` navigation required login; a subsequent cold offline navigation showed no private feed.

The raw intent, sanitized result and screenshots remain under ignored, private `artifacts/private/hosted-smoke/`. Credentials are read in-process and never printed. Raw browser errors, traces and console output are not collected. Failure cleanup uses the normal same-origin signout endpoint, verifies the session ended, clears locally remembered keys/cookies and reports any unconfirmed cleanup. The profile directory is private and a symbolic-link profile is refused.

## Reproduction and limits

Install the pinned development dependencies and test Chromium with `npm ci` and `npx playwright install chromium`. Run `npx tsx scripts/hosted-browser.ts session --attempt=<eight-new-hex-characters>` only after coordinating ownership of the existing staging synthetic fixture. The runner requires a live known history fixture, records an exclusive private intent before login, and refuses reusing an attempt identifier. Inspect an interrupted attempt before choosing to resume testing. The private profile preserves its device identifier; later recovery can reuse that device instead of creating another.

This is real hosted browser evidence, separate from the earlier manually installed PWA/update test. It does not establish actual Web Push delivery, a complete browser archive/photo round trip, an external integration consumer, screen-reader usability, physical-device iOS behavior, or the remaining delivered-mail/staff-recovery flows. Those checks remain explicit in [hosted verification](hosted-verification.md) and [build status](build-status.md).
