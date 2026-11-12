# Event-triggered Porchday recovery

The owner authorized the independent monitor to start an unattended incident
task when Porchday is unavailable. GitHub owner notifications remain enabled.
Previously that notification was the end of the automation: no process consumed
it to start a responder. An open goal or an issue mention did not wake ChatGPT.

The existing Mac monitor checks actual authenticated journeys every 20 seconds.
Two consecutive failed probes, no more than 45 seconds apart, trigger one local
Codex incident turn through the authenticated app-server daemon. No inference is used for
healthy probes, timers, state persistence, or daemon status reads. There is no
recurring ChatGPT automation. The existing Mac must remain powered, awake,
logged in, network-connected, and authenticated to Codex.

Configure the private monitor JSON with an `incidentDispatch` object containing
absolute `cwd` and `codexPath` paths. The checkout must contain this runbook and
the maintained recovery tools. Use the already installed Codex CLI and its
managed daemon (`codex app-server daemon version`). The monitor connects through
the daemon’s owner-controlled Unix WebSocket socket; it does not copy authentication tokens or require a
new API key. Threads use the user's configured default model. Each responder is
an ordinary durable Codex thread under the local account; inference consumes
the applicable account allowance only when the incident turn runs.

Each incident has an owner-only durable record in `state/incidents`. Creation,
thread identity, turn dispatch intent and acknowledgment are persisted in order.
Restart does not create another turn for an acknowledged incident. An unknown
turn response is reconciled by reading the recorded thread; it is never blindly
replayed. Ambiguous creation or a turn that cannot be confirmed requires review.
No two simultaneous calls from this dispatcher can start work. If the previous
incident's responder is still running when a new incident starts, it is reused
without another inference turn. If it has finished, resume the same durable
thread and add the new incident there instead of creating another thread.
Intervening unconfirmed failures retain that thread reference. Bounded turn
pagination avoids downloading the entire accumulated conversation. On a lost
send acknowledgment, require the new incident marker rather than accepting an
older completed turn as proof of dispatch. Recheck recovery before sending work.
The shared deployment lease remains the final protection against concurrent
production changes by any task or operator.

The task receives fixed check names and timestamps, never credentials, cookies,
response bodies, or member data. Its prompt requires fresh diagnosis, current
deployment provenance, the guarded recovery protocol, teardown, queue resumption
and authenticated verification. A healthy service is not changed merely because
an old alert arrived. The model must never infer rollback from elapsed time,
discard a privacy intent, fabricate a receipt, reset capabilities, or bypass a
privacy check. A model is not itself evidence that an operation is safe.

If dispatch fails, becomes ambiguous, finishes while checks remain unhealthy,
or remains active for over 15 minutes, the monitor queues an owner notification
through the independent GitHub bot relay. The finite `backup_execution` check
also identifies responder-execution trouble; inspect `incident_dispatch_*` logs
and the matching private incident record. Reminders are limited to one per 15
minutes. These notifications prove GitHub acceptance, not human acknowledgment.
There is no unbounded chain of paid retry turns. Resolve blocked credentials or
approval needs and continue the existing task explicitly.

Recovery notifications now require 140 seconds of uninterrupted healthy
observations, with gaps resetting the timer. Two good checks could previously
fall inside the journal's 120-second stale-intent grace period, announcing a
false recovery before quarantine. This stability rule does not replace journal
proof or establish a monthly SLO.

## Verification and operations

Test the state machine with fake observations and RPCs: healthy idle, transient
failure, sustained outage, restart, duplicate suppression, lost acknowledgments,
daemon failure and stable recovery. A live dispatch drill uses a **separate**
private state directory and `drill=true`, starts a read-only task, and never
changes production observations or creates a real incident. Confirm the task
continues after the dispatch client disconnects and appears in the local app.
Do not induce a production outage to test dispatch.

Keep the production bundle and private configuration backed up before changing
the launch agent. Stop the old monitor before installing the replacement so the
synthetic account has only one writer. Preserve observation history and pending
notifications. Verify fresh full journeys after restart. Roll back the bundle
and config together if startup fails; do not erase incident state or a pending
dispatch to make the daemon appear healthy.

## Recovery tooling caveat

The November 3 manual recovery hit a legacy 240-second child-process timeout
during its second full journal verification. SIGTERM prevented ordinary bridge
teardown. Read-only reconciliation established unchanged SQL/control/capability
state, the exact temporary bridge was removed, and the **same** reviewed ticket
completed with a 900-second operator budget. Request deadlines and safety checks
were retained. Never blindly run the historical wrapper or repeat an unknown
write. A ticket expires after 30 minutes; establish a measured budget and a
teardown/reconciliation plan before invocation. Journal verification and media
checks must not be skipped for availability.

Official protocol: [Codex app-server](https://learn.chatgpt.com/docs/app-server).

## November 12 notification-noise remediation

Recorded history contained 40 distinct accepted responder threads over nine
days. The old dispatcher only reused a still-running responder, and lost its
thread reference after an intervening transient incident. These are confirmed
causes of the repeated identical conversation previews. The initial prompt now
begins with an incident-specific summary. Existing conversations are retained.

Outage notifications now require two failed probes within 45 seconds, matching
responder dispatch. All raw failures remain in append-only observations; this is
notification confirmation, not a change to measurement or request deadlines.
Recovery still requires 140 uninterrupted healthy seconds. The backup monitor
retains `healthy=false` for any failed probe but exits unsuccessfully for an open
confirmed incident or delivery/execution failure, not a lone recovered sample;
otherwise a transient probe would become a spurious `backup_execution` incident
on the next scheduled run.

Rollout must preserve current incident/outbox/history state. Where the old bug
has already erased the previous thread pointer, recover it from the latest
acknowledged archived incident after read-only identity/status verification.
Never replace an active or uncertain dispatch to make rollout easier.
