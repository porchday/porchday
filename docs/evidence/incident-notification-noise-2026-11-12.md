# Incident notification noise — November 12, 2026

Delivered through [PR #224](https://github.com/porchday/porchday/pull/224), source `d86214dc083753454c460acbe62b7b76c31adaab`, merge `a9c36070e617a907256cf53bfeb6f2928747e3dc`. Tracking: [#8](https://github.com/porchday/porchday/issues/8); underlying latency investigation remains [#55](https://github.com/porchday/porchday/issues/55).

## Confirmed causes

The screenshot's repeated conversation previews match the independent monitor's incident prompt. Its private incident history contained 136 incident records and 40 accepted dispatch records with 40 distinct responder threads across November 3–11. The dispatcher reused only a still-running responder; once it finished, another confirmed incident created another thread. An intervening incident that never dispatched also discarded the previous thread reference. Each new thread began with the same authorization sentence.

In the fixed 24-hour window November 11 15:26 UTC–November 12 15:26 UTC, 4,319 probes included 25 failures in 18 clusters: 13 isolated failures, four two-probe clusters and one four-probe cluster. Most failures involved logout/revocation deadlines; some simultaneous endpoint deadlines and 503s also occurred. These synthetic observations do not prove that every member experienced a complete outage, or establish the provider/network cause of each delay.

GitHub outage delivery previously started after one failed probe, generating an outage/recovery pair for isolated failures. The backup CLI also exited unsuccessfully for any failed observation, allowing a recovered one-probe failure to be reclassified as an execution incident on the next run.

## Remediation

- Resume the same durable incident conversation for later incidents. Preserve its reference across transient incidents and reuse an active responder without another inference turn.
- Read bounded turn metadata instead of the full accumulated conversation. On uncertain reused-thread sends, require the current incident marker and distinguish the preceding turn. Never blindly replay an uncertain send.
- Recheck recovery after connecting, before starting paid work.
- Confirm notifications with two consecutive failed probes no more than 45 seconds apart. Keep all raw failure observations, existing request deadlines and 140-second stable recovery.
- Keep backup `healthy=false` for a failed observation, but do not turn a recovered isolated sample into a workflow-execution failure. Confirmed open incidents and actual delivery/execution failures still fail the job.
- Make new incident prompt previews specific rather than repeating the authorization sentence.

The [official app-server protocol](https://learn.chatgpt.com/docs/app-server) documents thread resumption, bounded history reads and reversible archiving. These metadata operations do not start an inference turn. Live protocol checks verified the existing daemon's turn/marker structure and resumed the retained thread without sending a turn.

## Validation

- 62 targeted monitor/dispatch tests passed: sustained outage, transient confirmation, gaps, restart, active responder reuse, completed-thread reuse, lost acknowledgment, old-turn rejection, recovery during connection and backup feedback.
- Full local suite: 1,384 passed / 327 skipped. Skipped checks are not claimed verified.
- Recorded 24-hour replay preserved all 25 failed observations, produced five confirmed outage notifications/five recovery investigations in **one** thread, and made no external writes or inference calls.
- Exact-source full CI [43248690883](https://github.com/porchday/porchday/actions/runs/43248690883), PR CI [43248793098](https://github.com/porchday/porchday/actions/runs/43248793098), secret scan and focused post-detail checks passed.
- iOS [43248690470](https://github.com/porchday/porchday/actions/runs/43248690470): 152 unit tests, four skipped, zero failures; three UI tests passed.
- macOS [43248690666](https://github.com/porchday/porchday/actions/runs/43248690666): 86 tests, zero failures.

## Production installation and cleanup

The exact-source independent Mac monitor bundle was installed at **2026-11-12 15:49:07 UTC**, after the maintained `verifyProductionNativeParity` gate and required source CI. Bundle SHA-256: `d780ee33e6b23542948aa2186bae17b9ec681b6546b460290660158cee731e2e`.

A short scoped maintenance lease serialized installation. An initial lease-busy attempt ended before installation intent; its evidence was preserved and the lease was not bypassed. The successful attempt backed up the previous bundle/configuration, stopped the old process and verified it exited before starting the replacement. Observation history, pending notifications and incident state were retained. The lost responder reference was restored from the latest acknowledged archived incident after daemon identity/status verification. The response workspace now points at the reviewed source checkout. The maintenance lease was archived after installation.

No hosted application, database, Worker route or signed-native change was needed; canonical application routing was unchanged. The backup fix became active on merged main.

Post-install verification passed eight consecutive healthy observations spanning **140,012 ms**, with zero failures, covering login, authorized profile/feed reads, logout/revocation, readiness, freshness and anonymous checks. The old-to-new monitor observation gap was **20,282 ms**, within the ordinary cadence allowance; no overlapping probe writers were used. Bundle identity, process continuity and retained responder reference were checked.

Twenty completed monitor-created duplicate conversations were reversibly archived and read back; nineteen were already archived. No conversations were deleted. The retained conversation was named **Porchday production incidents** and verified unarchived. Cleanup required a matching acknowledged incident turn, a completed single-turn history, no active runtime and no spawned descendants; continued/uncertain/active conversations were excluded by the script.

The live GitHub backup [43251999436](https://github.com/porchday/porchday/actions/runs/43251999436) passed on merged main with notification-drill mode off: `healthy=true`, `notificationsDelivered=true`, `incidentOpen=false`. It correctly reported an existing execution gap: the preceding scheduled run ended at 12:36:37 UTC, over three hours before this manual check. This successful manual run does **not** establish reliable five-minute scheduled execution; that remains open in #8. The gap/recovery notifications are not artificial drill notifications.

## Remaining work

The intermittent request latency/provider/network causes remain in #55. GitHub's sparse scheduled backup executions and owner/device receipt acceptance remain in #8. This release fixes notification handling and thread clutter; it does not claim those underlying reliability problems have been eliminated. No fault was induced to validate production automatic recovery; dispatch behavior is covered by deterministic tests and a real-observation replay, while live daemon checks deliberately started no paid turn.

Private evidence: `artifacts/private/incident-noise-20261112` (bundle, backups, gates, install/monitor receipts, replay and archive records; not committed).
