# October 27 placement comparison and revised watch

Nick's 06:13 PDT request authorized investigating the operations-health rollback
and another promotion if signed-in US measurements passed. PR #38 added
capability-authorized numeric phase timings and the member-based watch policy.
No authentication, journal, revocation or member-data cache was introduced.

Four alternating staging blocks on the same US Mac and backend source gave
30 attempts per route per mode, with no errors and no warmup/outlier exclusions.
The fixture was an isolated synthetic account with an empty feed. These are
sequential route measurements, not a capacity test or Philippines result.

| Route | Edge median / p95 (ms) | Oregon median / p95 (ms) |
| --- | ---: | ---: |
| `/me?bootstrap=1` | 303 / 912 | 222.5 / 677 |
| Feed | 513.5 / 703 | 332.5 / 402 |
| Operations-health | 153 / 273 | 176 / 490 |
| App shell | 45.5 / 524 | 34.5 / 142 |
| Color-scheme script | 24 / 48 | 26 / 55 |

The member-route gate passed; public bytes/caching matched and public medians
were within five milliseconds. All intermediate blocks and tails were retained.

Operations-health executes the same two SQL statements in both modes: the fresh
journal status read, then the combined operational/backup snapshot, using
separate clients. Its median Worker time improved from 126.5 to 105ms and
snapshot time from 54 to 27ms, with negligible connection-close time. Median
client time outside the Worker increased from 24 to 69.5ms. The two slowest
Oregon health requests spent 384 and 635ms outside the Worker. Journal stalls
also occurred on edge; the slowest edge health request spent 477ms in its
journal check. The measured overhead explains why health can regress despite
faster SQL and faster member routes. The residual includes network, routing and
transfer; it is not an isolated service-binding hop measurement or a definitive
attribution of every spike in the previous watch, which lacked phase timings.
Medians of separate phases need not sum to the median total.

The new watch uses 30 signed-in synthetic `/me` and feed requests per checkpoint
plus aggregate API errors. Operations-health is warning-only. See the policy in
`placement-watch-policy.mjs` and the live outcome in issue #9. Production's
pre-promotion baseline was `/me` 265/303ms and feed 525/581ms (median/p95).
The first post-promotion checkpoint was 238/393ms and 374.5/451ms respectively,
with zero errors: improved medians but a `/me` tail warning requiring the next
checkpoint before rollback. This initial checkpoint does not establish that the
one-hour watch passed. Do not merge the accompanying production-default change
until the watch is complete without unresolved member regression; close it if
the rollout rolls back or is superseded.
