# Hourly release instruction update — October 29, 2026

The existing `deploy-porchday-updates-hourly` heartbeat was updated through the
app automation tool and its saved configuration read back. It remains ACTIVE;
its hourly schedule and target chat are unchanged. No deployment was performed.

The instructions now require the maintained upload/activation commands and
SQLite-backed shared leases instead of manual directory-lock handling. They pin
known tooling commit `6139bce8a4e83bc0442441b434192c09b37fcbd1` separately from
candidate application source, require review/checks for newer tooling, and stop
before writes if required tooling or evidence is unavailable. Historical
single-use helpers and raw provider writes are not fallback release paths.

Required gates include the synthetic-account preflight, durable authenticated
journeys, an existing-session continuity baseline before dispatch, observation
through activation/recovery, and two samples starting after command completion.
Failures, gaps and incomplete coverage remain visible. Feature releases also
require applicable old/new API, already-open web and native-client compatibility,
retained old assets, bounded compatible migrations and rollback evidence before
production promotion. Monitoring and revocation deadlines remain intact.

The stale first-scheduled-release instruction was corrected against issue #26
and its verified October 27 release comment 6443026372. That historical acceptance
remains valid. Adoption of these strengthened instructions by an eligible
scheduled feature release remains unverified under issue #3.

Validation: exact prompt readback matched the submitted update; status, schedule
and target matched their original values. This is an instruction/configuration
change, not a new executable gate or evidence of feature/client/schema overlap.
No runtime tests or provider mutations were performed for this update.

Next acceptance: observe an eligible scheduled release using the maintained
commands, retain staging/production compatibility and continuity evidence, and
verify rejected preconditions cause no provider writes. A no-change run does not
satisfy this acceptance. Monthly 99.99% availability remains unproven.
