# Reliability runtime alignment with main

This integration starts from main `38e320a463cb2a65f279265c1aa4acff10a24c19`
and reconciles the API runtime previously staged at
`df24f840c279fb48112e29ef6c5cbfff542b6ea3`. It preserves main's web and native
clients, CI checks, protected operational Server-Timing, and early read-only
schema preparation for both profile and feed requests.

## Runtime and schema

Session denial readers remain unconditional. Migration 056 adds push delivery
functions that include the authorizing session, while retaining the prior SQL
interfaces for compatible older consumers. HTTP authentication and both push
workers enforce immutable session denials. The writer requires both writer and
cleanup flags; this integration does not enable either flag in production.

Scheduled cleanup uses v3 SQL-session keyset discovery. Each candidate requires
canonical immutable denial authority before exact identity-locked SQL deletion.
Conditional progress records and continuation tokens prevent stale work from
advancing a newer pass. Protected health reads independent cleanup progress in
parallel with the database snapshot and releases its SQL connection promptly.
The v1/v2 modules remain for compatibility with existing rollback tooling.

Logout diagnostics retain the aggregate numeric summary already deployed to
production. Missing phases remain -1, and nested I/O timings overlap enclosing
phases. Metrics failures cannot replay work or alter a logout result.

Migration execution has bounded lock and statement waits. A failed attempt must
be reconciled before another invocation; see [migration safety](migration-safety.md).
The local integration test verifies migration 052 rolls back completely when
blocked, leaves reads available, and applies on a separate invocation after
read-only confirmation of rollback.

## Deployment gates

Source alignment alone does not authorize an unguarded main deployment. Use the
maintained release tooling, exact commit CI, pinned assets and schema, a fresh
external journey, the deployment lease, compatible reader floors, and continuous
old/new-client verification. Reconcile every started or unknown one-shot write
before considering another operation. Retain failed acceptance evidence.

Production writer and cleanup bindings must remain absent for this rollout.
Staging retains both enabled flags and its existing v3 progress; check actual
fresh full-pass completion rather than fabricating bootstrap timestamps. Never
rollback below the denial-reader floor. A v2 rollback additionally requires real
fresh v2 progress; v3 timestamps cannot stand in for it.

A hosted feature UI check has passed separately, but it did not overlap a
deployment. Real old/new web and native compatibility during a feature release,
physical-device checks, production latency investigation, and measured monthly
availability remain outstanding. This change does not establish 99.99% uptime.

Tracking: #3 (release acceptance), #55 (logout latency), and #41 (invitation UI).

## Staging acceptance on October 29

[Recorded evidence](evidence/main-alignment-staging-2026-10-29.json) pins the
exact runtime source and CI runs. A guarded backend activation passed 13
continuity samples with zero failures, including two post-terminal samples.
Existing allowed sessions remained usable, revoked cookies were rejected, and
all synthetic fixture rows were removed. Protected operational timing appeared
on authenticated health responses and was absent from anonymous 401 responses.
A later read observed an actual scheduled cleanup pass advance.

The first private harness attempt stopped before activation because its event
directory was missing. Its fixtures were reconciled and removed before the
fresh attempt; the failed result was retained. The new harness requires its
event directory before creating fixtures. No unknown write was replayed.

This verifies the API source alignment on staging. It does not close the
already-open browser/new-client feature-release or physical native-device gates,
and does not promote the candidate to production.
