# Independent service monitoring

`apps/monitor` is a separate Cloudflare Worker. It has no PostgreSQL, Hyperdrive, application R2, queue, or member-session binding. Its one-minute cron checks the selected environment's protected `/api/operations/health` endpoint. A SQLite Durable Object stores only check counters, incident timestamps, delivery retry state, and generic service status. The application never calls this Worker; a monitor, email, or state-storage failure cannot delay a member request.

The application endpoint checks cleanup heartbeat age, deletion queues, identity removal, account email backlog, and restore-journal readiness. The monitor makes a ten-second request to a fixed compiled target, does not follow redirects, caps the response at 16 KiB, and discards all protected diagnostic fields after deciding whether the response is healthy. It stores no account, post, device, email-content, or database identifier. Requests and provider response bodies are never logged.

Three consecutive failed checks open an incident. A successful outage email is followed by at most one reminder every six hours. Two consecutive healthy checks produce a recovery email, provided an outage email was delivered. Duplicate cron invocations in the same minute do not produce additional checks or messages. Delivery failures retry after five minutes with exponential backoff capped at one hour. Retry state is persisted before sending. A crash after provider acceptance but before storing success can produce a later duplicate; exactly-once delivery is not promised. A ten-second email timeout bounds the monitor's execution even if the provider stalls.

The public `/` path serves an accessible Porchday status page with a generic availability message and last checked time; `/status` retains JSON containing only `status` and `last_checked_at`. Status is `checking`, `operational`, `degraded`, or `unknown`. More than three minutes without a completed check yields `unknown`; a state-storage failure also returns generic unknown with HTTP 503. Every response is uncached and uses a restrictive CSP. The HTML has no scripts, external assets, or tracking; only fixed status text and a validated, escaped timestamp can be rendered. A refresh link reads the latest completed observation without triggering a new probe. There is no public check, test-email, or administrative trigger. The scheduled handler alone forwards a fixed internal request to the Durable Object.

## Configuration

Run `python3 scripts/configure-monitor.py staging` or `production` to render the separate deployment configuration. This does not deploy it. Production uses `status.porchday.com`; staging uses `staging-status.porchday.com`. Each deployment owns its Durable Object namespace and alert state. The generated configuration enables the minute cron, a 1,000 ms CPU limit, native Cloudflare Email Service, and sanitized logs without invocation logs or traces. The local base configuration has no cron or remote email binding.

Install these values through the private secret workflow:

- `OPERATIONS_HEALTH_TOKEN`: the same environment-specific token installed on the application. This authenticates only the aggregate health endpoint, never a member or staff session.
- `MONITOR_RECIPIENT`: the operator's chosen monitored email address. Keep this out of committed configuration and logs.
- `EMAIL_FROM`: a verified sender on the configured Cloudflare Email Service domain. The generated config currently uses `Porchday <accounts@porchday.com>` with that sender allowlisted.

Deploy only after the application hostname exists, its operations token is installed, the email sender is enabled, and an operator recipient is configured. Keep staging and production tokens distinct. Review the generated routes before deployment; do not overwrite an existing unrelated status site. Check the public status, then perform an authorized controlled staging incident to verify actual email delivery and recovery before treating alerting as operational. Unit tests use an injected email service and do not send mail.

`python3 scripts/with-secrets.py python3 scripts/upload-monitor-secrets.py staging --check` validates private configuration without uploading. Omit `--check` after the target monitor is deployed to upload through stdin. Use `production` for the other environment. The recipient defaults to the configured Cloudflare account owner, matching the existing budget alert; set `PORCHDAY_OPERATIONS_EMAIL` in the private secrets file to choose another monitored address. Name a backup responder before real-member admission. No recipient or capability is printed.

## Operations and limitations

A 30-day month produces approximately 43,200 checks per environment, one small durable state record, and low alert volume. Public status visits add reads. Track actual Workers, Durable Objects, and email usage against the setup/operating budget; no paid third-party monitor is required for this path.

This monitor is independent of the application and database, but shares Cloudflare's platform and email service. A broad Cloudflare outage can affect both checking and alert delivery. Configure a separately operated uptime check or Datadog check of the public status endpoint when that account is available, including detection of stale `last_checked_at`. The public timestamp helps an outside checker detect a stopped cron; the Worker cannot email through a complete outage of its own platform.

Troubleshooting logs contain only `monitor/check_failed` or `monitor/alert_retry` and the environment. Inspect private aggregate application health to diagnose the underlying problem. Do not temporarily add response bodies, tokens, URLs containing secrets, recipient addresses, or raw exception messages to logs. Storage failures deliberately stop untracked mail attempts. Email delivery configuration needs separate operational verification; a green application status does not itself prove an operator email can be received.

`apps/monitor/test/monitor.test.ts` covers fixed target and redirect policy, bounded input, timeout/cancellation, thresholds, concurrent duplicate ticks, reminders, retries, redaction, storage isolation, no public trigger, and stale public state. The Worker also passes Wrangler's packaging dry run; this is not evidence of remote deployment or successful real alert delivery.

Implementation references: [Cloudflare cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Durable Object state and concurrency](https://developers.cloudflare.com/durable-objects/api/state/), and [Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
