# External availability monitoring

The owner selected **GitHub issue notifications to repository owners** for alerts outside Cloudflare. The verified owners are `@andyk` and `@bobbyhwilder`. The dedicated [operator Mac alert thread](https://github.com/porchday/porchday/issues/52) stays open as a notification destination; an open issue is not itself an active incident. Engineering acceptance remains in [#8](https://github.com/porchday/porchday/issues/8) and [#42](https://github.com/porchday/porchday/issues/42).

## Probe and notification behavior

`scripts/external-monitor.ts` runs a bounded synthetic journey every 20 seconds, with no overlapping checks or catch-up burst after a sleep or restart. A cycle has a 10-second network deadline. It checks protected readiness, anonymous authentication on both production domains, monitor timestamp freshness, synthetic login identity, authorized profile and empty feed, logout and rejection of the revoked cookie. It rejects redirects, limits response bodies to 16 KiB and emits only fixed check names, HTTP statuses and timestamps. It never emits response bodies, member identifiers, cookies or passwords. There is one logout attempt; an ambiguous write is not replayed. A timed-out logout can leave a synthetic session until expiry and requires investigation if repeated.

The synthetic identity must be a dedicated UUID with the matching `UUID@example.test` address and no relationships, posts, staff access or real-member content. Its fixture is operator-provisioned; never substitute a member's credentials. No database or Cloudflare deployment credentials are passed to the daemon. The configuration contains only the synthetic credentials, protected-readiness token, production environment and dedicated issue number. Files require owner-only permissions.

One failed cycle queues an outage notification. Two consecutive successful cycles, at most 45 seconds apart, queue recovery. State and pending notifications survive restart. The reporter checks the dedicated issue and reconciles the exact persisted event body before retrying an uncertain GitHub comment write. Unchanged failures do not repeatedly mention the owners. Notification failures remain queued and are retried after at least 60 seconds; probe collection continues independently. Public comments contain fixed checks and aggregate outcomes only. Ordinary comments and engineering issues are never deleted or closed by this monitor.

Every observation is retained in an append-only UTC monthly JSONL file. Gaps in timestamps are unknown, not healthy; a restart does not reset prior failures. These observations measure this probe's scope, not complete application availability. Do not compute a whole-month success percentage by silently dropping unobserved time. Keep at least 30 days and completed-month reports before any retention change.

## Installation and operation

Bundle the reviewed source with `esbuild scripts/external-monitor.ts --bundle --platform=node --format=esm`. Install a pinned copy in an owner-only directory outside the mutable checkout. Run it with an absolute Node path, an owner-only JSON configuration path, an owner-only state directory, and `--continuous`. `--once` performs one production cycle with the same durable alert handling and returns failure if an incident or notification remains pending. Use one launchd service for the production identity; do not run a second manual copy against that identity while the service is active.

The launchd service should use `RunAtLoad`, `KeepAlive`, a restart throttle, the configured user's home directory for the existing `gh` credential store, and separate private stdout/stderr files. The default GitHub CLI path is `/opt/homebrew/bin/gh`; set `PORCHDAY_MONITOR_GH_PATH` when needed. Do not wrap the daemon in the deployment-secret loader. Stop the launchd service before changing its configuration or bundle. Preserve state and observation files across upgrades, verify the bundle hash, restart and check fresh observations and notification backlog.

Investigate a failed check through [the reliability runbook](reliability.md) and [restore safety](restore-safety.md). Verify user-facing behavior before declaring recovery. Never bypass privacy quarantine, weaken revocation, retry an ambiguous member mutation or restore a database merely because the monitor failed. Notification drills must be labeled explicitly and use simulated failures, not intentional production outages. Record GitHub acceptance separately from actual owner receipt.

## Limits and outstanding acceptance

- A Mac launch agent depends on that Mac being awake, logged in, connected and running its pinned Node and GitHub CLI installations. It is an external vantage point, not a highly available monitoring service. An independent hosted backup is still required.
- GitHub API availability and the owners' GitHub notification settings govern delivery. A successful comment write does not prove an inbox notification, operator response or a guaranteed delivery time. GitHub is independent of Cloudflare, but this is not a dedicated paging service.
- A nominal 20-second interval plus 10-second deadline targets detection within 30 seconds while running. Scheduling, sleep and transport delays prevent a guaranteed bound. A five-minute scheduled GitHub job alone cannot meet that objective.
- Encrypted writes/deletes, mail delivery and independent regional coverage are not yet included. No automatic production recovery is performed. These checks do not prove 99.99% monthly availability.
- Three fresh login/logout cycles per minute add synthetic traffic and journal operations. Staging and production acceptance must verify that cadence before continuous installation. Observe unintended rate limiting and database/journal load rather than weakening limits for the monitor.

Installation and live acceptance evidence will be recorded in this document after verification. Unit tests cover hidden readiness failures, identity isolation, private reads, revocation, redirects, response bounds, deadlines, alert transitions, gaps, persistence and lost GitHub acknowledgements.
