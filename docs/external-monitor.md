# External availability monitoring

The owner selected **GitHub issue notifications to repository owners** for alerts outside Cloudflare. The verified owners are `@andyk` and `@bobbyhwilder`. The dedicated [operator Mac alert thread](https://github.com/porchday/porchday/issues/52) stays open as a notification destination; an open issue is not itself an active incident. Engineering acceptance remains in [#8](https://github.com/porchday/porchday/issues/8) and [#42](https://github.com/porchday/porchday/issues/42).

## Probe and notification behavior

`scripts/external-monitor.ts` runs a bounded synthetic journey every 20 seconds, with no overlapping checks or catch-up burst after a sleep or restart. A cycle has a 10-second network deadline. It checks protected readiness, anonymous authentication on both production domains, monitor timestamp freshness, synthetic login identity, authorized profile and empty feed, logout and rejection of the revoked cookie. It rejects redirects, limits response bodies to 16 KiB and emits only fixed check names, HTTP statuses and timestamps. It never emits response bodies, member identifiers, cookies or passwords. There is one logout attempt; an ambiguous write is not replayed. A timed-out logout can leave a synthetic session until expiry and requires investigation if repeated.

The synthetic identity must be a dedicated UUID with the matching `UUID@example.test` address and no relationships, posts, staff access or real-member content. Its fixture is operator-provisioned; never substitute a member's credentials. No database or Cloudflare deployment credentials are passed to the daemon. The configuration contains only the synthetic credentials, protected-readiness token, production environment and dedicated issue number. Files require owner-only permissions.

One failed cycle queues an outage notification. Two consecutive successful cycles, at most 45 seconds apart, queue recovery. State and pending notifications survive restart. The Mac reporter dispatches the Actions bot relay and acknowledges delivery only after reading the exact bot-authored comment; uncertain dispatches remain in the persistent outbox. Unchanged failures do not repeatedly mention the owners. Notification failures remain queued. The reporter source polls read-back every five seconds independently of probes; only relay dispatch attempts have a durable 60-second cooldown. A failed GET does not consume that cooldown. Probe collection continues independently. See the installation evidence below for the currently verified release. Public comments contain fixed checks and aggregate outcomes only. Ordinary comments and engineering issues are never deleted or closed by this monitor.

Every observation is retained in an append-only UTC monthly JSONL file. Gaps in timestamps are unknown, not healthy; a restart does not reset prior failures. These observations measure this probe's scope, not complete application availability. Do not compute a whole-month success percentage by silently dropping unobserved time. Keep at least 30 days and completed-month reports before any retention change.

## Installation and operation

Bundle the reviewed source with `esbuild scripts/external-monitor.ts --bundle --platform=node --format=esm`. Install a pinned copy in an owner-only directory outside the mutable checkout. Run it with an absolute Node path, an owner-only JSON configuration path, an owner-only state directory, and `--continuous`. `--once` performs one production cycle with the same durable alert handling and returns failure if an incident or notification remains pending. Use one launchd service for the production identity; do not run a second manual copy against that identity while the service is active.

The launchd service should use `RunAtLoad`, `KeepAlive`, a restart throttle, the configured user's home directory for the existing `gh` credential store, and separate private stdout/stderr files. The default GitHub CLI path is `/opt/homebrew/bin/gh`; set `PORCHDAY_MONITOR_GH_PATH` when needed. Do not wrap the daemon in the deployment-secret loader. Stop the launchd service before changing its configuration or bundle. Preserve state and observation files across upgrades, verify the bundle hash, restart and check fresh observations and notification backlog.

Investigate a failed check through [the reliability runbook](reliability.md) and [restore safety](restore-safety.md). Verify user-facing behavior before declaring recovery. Never bypass privacy quarantine, weaken revocation, retry an ambiguous member mutation or restore a database merely because the monitor failed. Notification drills must be labeled explicitly and use simulated failures, not intentional production outages. Record GitHub acceptance separately from actual owner receipt.

## Limits and outstanding acceptance

- A Mac launch agent depends on that Mac being awake, logged in, connected and running its pinned Node and GitHub CLI installations. It is an external vantage point, not a highly available monitoring service. A hosted backup is configured and its manual execution is verified; actual scheduled execution still needs observation.
- GitHub API availability and the owners' GitHub notification settings govern delivery. A successful comment write does not prove an inbox notification, operator response or a guaranteed delivery time. GitHub is independent of Cloudflare, but this is not a dedicated paging service.
- A nominal 20-second interval plus 10-second deadline targets detection within 30 seconds while running. Scheduling, sleep and transport delays prevent a guaranteed bound. A five-minute scheduled GitHub job alone cannot meet that objective.
- Encrypted writes/deletes, mail delivery and independent regional coverage are not yet included. No automatic production recovery is performed. These checks do not prove 99.99% monthly availability.
- Three fresh login/logout cycles per minute add synthetic traffic and journal operations. Staging and production acceptance must verify that cadence before continuous installation. Observe unintended rate limiting and database/journal load rather than weakening limits for the monitor.

## Hosted backup implementation

`.github/workflows/external-monitor.yml` is enabled on the default branch with a five-minute schedule, offset from the hour, and manual dispatch. Manual execution is verified; schedule configuration alone is not proof of automatic execution. It uses a standard GitHub-hosted Ubuntu runner and native Node 24, with no package installation. The public repository uses [standard runners without a minute charge](https://docs.github.com/en/actions/concepts/billing-and-usage). No Actions artifacts are uploaded. Only the fixed-format synthetic observations and execution outcome enter job logs; retain and export those logs alongside the Mac history when preparing availability reports.

The hosted identity is separate from the Mac identity. Its scoped JSON configuration is stored in the repository secret `PORCHDAY_EXTERNAL_MONITOR_CONFIG`; it includes no database or deployment credential. The workflow token is limited to repository contents/actions read and issue write. Scheduled and dispatched jobs refuse any repository or branch other than `porchday/porchday` on `main`. The destination is [the hosted backup alert thread](https://github.com/porchday/porchday/issues/53).

Each job makes two observations 20 seconds apart, with the same 10-second cycle deadline and synthetic account protections. Exact machine-generated comments from `github-actions[bot]` retain outage/recovery state across runners. Human comments, altered bodies and explicit drills are not accepted as state. Keep the destination title and machine-generated notification bodies unchanged; add context in a new comment. A failed notification acknowledgement is reconciled before another write. If GitHub state cannot be read, probes are still recorded and the job fails visibly rather than claiming notification delivery.

The next successful execution also checks whether the previous run failed, was cancelled or is older than 12 minutes. If that failure was not already represented by an outage, it reports `backup_execution`; two fresh healthy observations then report recovery. This retains notice of an execution/notification gap even when the application has recovered before the next run. It does not reconstruct unobserved application behavior. The job is unsuccessful if application checks, notification delivery or execution-history access fail.

Manual dispatch can request `notification_drill=true`. After healthy real probes, it posts an explicitly simulated outage and recovery. The drill uses stable run-based IDs/timestamps so a rerun does not repeat notifications and never changes the real outage state. It induces no production outage.

This is backup detection, not continuous sub-minute monitoring: GitHub documents [delayed or dropped scheduled runs](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows) and [automatic schedule disabling after 60 days of public-repository inactivity](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows). A scheduler that stops entirely cannot report its own failure until execution resumes. The Mac and hosted checks do not guarantee a 30-second bound while either execution or delivery is unavailable. The hosted manual run and bot notification delivery are verified below. Scheduled execution and responder acceptance remain outstanding; source and tests alone do not prove those behaviors.

## Bot-authored owner notifications

The original Mac installation posts through the operator's GitHub account. GitHub has a [separate notification preference for your own updates](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications), so a successful self-authored mention does not prove that the operator received an alert. The original drill remains unconfirmed.

The upgraded Mac monitor routes notifications through `.github/workflows/external-monitor-relay.yml`. The Mac submits only validated event metadata and an explicit drill flag; the main-branch workflow posts the fixed notification as `github-actions[bot]`. It receives no application credentials. Dispatch is restricted to the two verified repository owners, and delivery is confined to #52. The source does not remove an event from the Mac's persistent outbox until it reads the exact bot-authored comment. Dispatch acceptance alone is not delivery. Repeated dispatches and workflow reruns reconcile the same event rather than repeating owner mentions.

This relay avoids reliance on the operator's own-activity preference, but normal notification settings and GitHub Actions/API availability still govern delivery. The action queue adds latency; a pending event is reconciled by read-only polling, with redispatch limited to once per 60 seconds while probes continue. The hosted backup already posts directly as the Actions bot to #53. The relay, Mac upgrade and bot-authored drills are verified below. Human acknowledgement and the second owner’s receipt remain unverified.

## Initial October 28 installation

The operator Mac launch agent `com.porchday.external-monitor` is installed in `~/Library/LaunchAgents/`. Its pinned bundle, scoped configuration, state and private logs live in `~/.config/porchday-external-monitor/`. The initial installed source was `1c6194ac82bd330daf1dfe7c2f6131b94613b793`; its bundle SHA-256 was `c15a0ee8368eed2d28514d2d6abed4e3695b169518811ac8c55bc270fbbdc48b`. Production collection began at **2026-10-28 20:54:02 UTC**. This deployment changed no Worker, application schema, domain or queue setting.

Inspect the service with `launchctl print gui/$(id -u)/com.porchday.external-monitor`. Stop it before maintenance with `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.porchday.external-monitor.plist`; resume with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.porchday.external-monitor.plist`. Keep the dedicated issue title unchanged: the reporter refuses unrelated or renamed destinations. Inspect private state and recent observations locally; never paste the configuration into an issue.

Both [push CI](https://github.com/porchday/porchday/actions/runs/40766631310) and [PR CI](https://github.com/porchday/porchday/actions/runs/40766640111) passed, including 828 tests in 116 suites, strict monitor type checking, build and secret scanning. The monitor adds 25 tests for hidden readiness failures, identity isolation, private reads, revocation, redirects, response bounds, deadlines, alert transitions, gaps, persistence and lost GitHub acknowledgements.

Staging's first cadence watch had six successful cycles and one cycle that reached the 10-second deadline across all initial requests at 20:47:57 UTC. Immediate public and protected follow-ups were healthy; no recent Mac sleep event was found. The initiating cause remains unconfirmed. The failure remains in the evidence. A second seven-cycle watch passed, and the staging identity was removed with absence verified. Production then passed seven cycles at the same cadence before installation, each including logout and old-cookie rejection, in 4.6–6.4 seconds.

GitHub accepted the explicitly simulated [outage notification](https://github.com/porchday/porchday/issues/52#issuecomment-6480281299) and [recovery notification](https://github.com/porchday/porchday/issues/52#issuecomment-6480281873), mentioning both verified owners. Owner receipt of that original operator-authored drill was unverified. Later bot delivery is documented below. Scheduled execution proof, encrypted-write probes, regional coverage and safe automatic recovery remain unfinished. No monthly availability achievement is claimed.

The installed daemon then passed seven consecutive cycles through 20:56:02 UTC with fresh persisted observations and no pending notifications. See the [sanitized acceptance record](evidence/external-monitor-2026-10-28.json), including the retained staging failure. This short watch establishes installation behavior, not sustained monthly availability.


## Hosted execution and bot relay acceptance

[PR #54](https://github.com/porchday/porchday/pull/54) merged the isolated reliability release after both CI runs passed **843 tests in 118 suites**, including 40 monitoring tests, native Node imports, strict typing, build and secret checks. The release source is `dfbf7e3edb6b1023127fa164933f70fcae125655`; the main merge is `dfd08960891c697f2bd4f429b607d2c9f5ad0b8c`. The earlier draft PR #51 was superseded; its unrelated iOS and builder-policy work remains on its original branch.

The [hosted manual run](https://github.com/porchday/porchday/actions/runs/40771588895) passed two real production journeys at 21:23:57 and 21:24:17 UTC in 5.4 and 4.6 seconds, including logout and old-cookie rejection. It verified the scoped secret, execution-history access and the bot-authored notification drill. The five-minute workflow is enabled, but no actual scheduled execution had been observed when this acceptance record was written. Do not treat manual dispatch as proof that scheduling works.

At 21:26:02 UTC the Mac bundle was upgraded to the same reviewed release source, SHA-256 `ca44ea289bd45ab9ac627893cdc4f65addcdf856743a7b6d9a33e2e5230d193e`. The upgrade waited for an idle interval after a successful journey, preserved credentials, state and history, and restarted the launch agent. The first 13 subsequent cycles passed with no pending notification. Separate [outage](https://github.com/porchday/porchday/issues/52#issuecomment-6481109693) and [recovery](https://github.com/porchday/porchday/issues/52#issuecomment-6481117842) relay drills were posted by `github-actions[bot]`. The authenticated owner’s repository-scoped notification API confirmed mention notifications for both #52 and #53 in `bobbyhwilder`’s GitHub inbox. This verifies GitHub inbox delivery, not email/mobile delivery, human acknowledgement or Andy’s receipt.

The ongoing watch also revealed **17 retained whole-journey deadline failures** before the bundle upgrade. The initial ten occurred between 21:11 and 21:15 UTC; subsequent failures are retained through the 21:30 evidence snapshot. Logout or the subsequent revocation observation exhausted the shared ten-second budget. A check attempted with an already-aborted signal does not prove failed revocation. Sampled server metrics showed sign-out p95 around 7.8 seconds with no sampled sign-out 5xx, and read-only follow-up found an active journal, no pending intents and no SQL quarantine. The cause is still unconfirmed in [#55](https://github.com/porchday/porchday/issues/55). The relay upgrade did not change the application or fix its latency; the later healthy cycles do not close that investigation.

See the [sanitized acceptance evidence](evidence/external-backup-2026-10-28.json). The production API release remained `44afbb8d-3133-4aac-8663-efd6fb5feb47`; this release deployed monitoring workflows and a local monitor bundle, not application Workers or production migrations. No monthly SLO achievement is claimed.


### Relay reconciliation latency correction

Real outage comments at 23:17 and 23:27 UTC arrived 20.197 and 97.182 seconds
after their probe start times. For the slower event, GitHub created the relay
workflow at 23:28:31 UTC and its comment at 23:28:41 UTC. Local logs show an earlier
pending notification at 23:27:23.989 UTC and the next attempt at 23:28:31.665 UTC.
Most of this delay therefore preceded workflow creation. The initiating request
failure is not classified further by the retained logs.

The former reporter applied a 60-second delay to every failure and every accepted
but unconfirmed dispatch. Recovery also waited behind that reconciliation. The
new source separates read-back polling from dispatch: it records a relay attempt
durably before POST, reconciles every five seconds without dispatching again, and
permits another dispatch only after 60 seconds. A restart retains that cooldown.
Failed reads can be retried promptly because they did not attempt a POST. When an
outage comment is verified, the queued recovery event can be dispatched immediately.

These intervals are scheduling targets, not delivery guarantees. Slow requests,
GitHub availability and recipient preferences still apply. The source correction
has local tests; installation and a live bot-delivery drill remain to be verified.

## Reproducible availability reports

Run the read-only reporter with Node 24:

```sh
node scripts/availability-report.ts --state-dir "$HOME/.config/porchday-external-monitor/state"
```

Use `--as-of 2026-10-28T23:43:40.000Z` for a fixed cutoff, `--month 2026-10`
for a calendar month, and `--environment staging` for staging history. Output
contains a UTC monthly report and a rolling 30-day report. The monthly error
budget uses the full calendar month; month-to-date coverage uses elapsed time.
The rolling window always spans 30 days ending at the cutoff.

Each completed 20-second UTC bucket receives at most one time weight. Any failed
sample in a bucket makes that bucket failed, even if another sample succeeds.
Buckets without a completed observation, gaps and the current incomplete bucket
remain unknown. Future or unfinished observations cannot establish coverage.
This is a sampled estimate of login, authorized reads, logout/revocation and
readiness—not continuous uptime or complete core-journey availability.

Read `coveragePercent` alongside `sampledSuccessRatePercent`; the latter uses only
observed buckets and must never be presented as a whole-month success rate.
`estimatedFailedSeconds` is a bucket estimate, not a claim about exact outage
start/end times. The report always leaves the broader SLO unestablished because
these probes omit encrypted writes, mail delivery and independent regional
coverage. Earlier incidents also remain part of the actual SLO even if they
precede this monitor's collection.

The reporter opens private history read-only, bounds each input at its opening
size, and includes byte counts and SHA-256 digests. Concurrent appends belong to a
later report. Malformed observations, mismatched monthly files, nonprivate files
and a torn trailing record stop reporting; they are never discarded to improve
availability. Preserve the input byte prefixes alongside retained reports to
reproduce a fixed snapshot. The reporter does not delete history or post alerts.
