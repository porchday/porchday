# Automatic access-update recovery — November 8, 2026

[PR #194](https://github.com/porchday/porchday/pull/194), application source `266a864d68fecfb6c0355f7314e1b1851fdae204`, merge `446d0fd4ddf43b74b959ba1e192691ff7e4cc354`. Tracks [#22](https://github.com/porchday/porchday/issues/22).

## Confirmed causes and correction

Both former history workers latched failures behind manual retry. Periodic checks, focus and reconnect did not clear the pause. A transient read failure, an audience conflict or an uncertain save could therefore leave catch-up stopped indefinitely. The photo worker additionally treated offline/hidden cancellation as unfinished. These lifecycle defects were reproduced; the owner's screenshot does not identify its initiating exception, and no private member content or keys were inspected.

Post and photo updates now use a shared automatic worker. It retries while the authorized vault is unlocked, online and visible, with independent exponential backoff from five seconds to five minutes and no attempt limit. Twenty-second polling and online/focus events drive checks. Each pass performs at most three actual preparations/writes, and scanning advances past failed items. Own-device recovery skips do not consume that budget. Going offline or hiding the app suspends preparation without a permanent error state.

Unknown writes are read back first. An exact committed candidate finishes without resubmission; an unchanged source permits reuse of the same encrypted body/media IDs. A changed source retires the stale candidate without deleting possibly attached media. Definitive rejection followed by an unchanged read discards unattached replacements and obtains a fresh audience. No client retry broadens consent, recipients or expiry. API/schema and environment-specific authentication runtimes are unchanged.

Manual retry buttons are removed. A nonblocking notice appears only when access is delayed and explains automatic retries. Signed-in navigation remains usable. Default iOS/macOS shells receive the shared UI fix; no new binary is required. This does not claim server-side decryption or guaranteed background execution while the app is closed.

## Validation

All 348 web tests across 56 files pass, including 42 focused retry/history/photo tests. Web typecheck and build pass. Full push CI and both exact-source native workflows passed:

- [Application CI](https://github.com/porchday/porchday/actions/runs/42550524128)
- [iOS CI](https://github.com/porchday/porchday/actions/runs/42550524145)
- [macOS CI](https://github.com/porchday/porchday/actions/runs/42550524167)
- [Secret scan](https://github.com/porchday/porchday/actions/runs/42550524207)

Staging and production hosted tests inject a failed post save, a failed photo read and lost responses after successful writes. Both automatically recover without a Retry button. The post retry reuses identical encrypted bytes (two submissions total); the photo performs one successful refresh. The new full-history recipient decrypts both metadata objects; production additionally verifies decryption of the actual attached and standalone photo bytes. Original post date is unchanged, its revision increments once, both queues drain, and navigation stays available. Recovered own-device-only gaps still cause zero refresh writes. Synthetic records are removed, with zero remaining fixtures.

Authenticated activation continuity, canonical routes, old/new open-tab assets, shared-shell rendering, automatic updates and encrypted draft preservation pass on both environments. No new native binary was required. Physical background/resume behavior and the original member-specific history scenario remain separately tracked in #49/#114/#22; these are not production blockers.

## Deployed versions

| Environment | Frontend Worker version | API version (unchanged) |
| --- | --- | --- |
| Staging | `5d117b0d-99a0-49b6-b704-bffdce7796a3` | `46053087-7233-4463-a5d9-ff22cb700e4b` |
| Production | `255c99e7-1298-4577-b04d-66ad560b6643` | `255f28f5-1031-46f0-b0db-a1351c3b0b95` |

Both frontends use `266a864d68fecfb6c0355f7314e1b1851fdae204`. API sources remain staging `a36d2cd146c542e31576c46c23dde4459b9a6bb4` and production `ac349af8c1734bb911e9bf269c2fb90de57b1ce3`. No schema changes.

The first staging activation preparation correctly rejected a local evidence file with overly broad permissions. The file mode was corrected; the failed read-only preparation was archived and activation resumed without repeating the upload. No production change resulted from that preparation failure.


Final provider/schema reconciliation passed at **2026-11-09 02:45:41 UTC**, confirming the deployed versions, unchanged schema, enabled publication and zero remaining fixtures. Production monitoring passed **eight samples over 140,012 milliseconds**, with zero failures.
