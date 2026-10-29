# Independent session denial: validation gates

As of October 29, 2026, 12:48 UTC, staging version `2120ff4c` runs isolated
runtime `8634c17` with logout writer and cleanup enabled. Production `f613874a`
retains server runtime `ebc567a4`, with both flags disabled. Current frontend
assets are `b2b3a06`. The maintained draft PR integrates the tested runtime code;
its broader development tree also contains unrelated features and is not the
deployment source.

Two exact-timestamp trials on this runtime now passed with 10,000 synthetic
sessions intact through both scans. The latest trial's scan durations were
204.221/226.230 seconds and exact completion intervals were 262.202/258.819
seconds, below the unchanged 300-second limit. All 25 sampled journeys passed.
All 100 private component results match the complete samples. Exact cleanup,
unchanged provider/canonical state and lease release were verified.
[Latest evidence](evidence/session-denial-diagnostic-repeat-10k-staging-2026-10-29.json).

The first completed trial had intervals of 185.052/255.657 seconds and 22 healthy
samples. The intervening repeat remains unaccepted after collection failed:
its one retained interval was 287.644 seconds, only 12.356 seconds below the
threshold. Two completed runs do not erase that narrow margin or establish a
capacity percentile, full mixed workload or continuous user availability.
[Comparison and limits](session-denial-capacity.md).

The preceding fixed-batch run's inferred interval above 300 seconds remains a
failure of capacity acceptance despite healthy sampled probes.
[Capacity evidence and limitations](session-denial-capacity.md) remain material.
A bounded six-session denied backlog also recovered through scheduled cleanup;
that does not establish pilot-scale denied-backlog capacity.

Current runtime `8634c17` passed a flag-only activation/automatic rollback
rehearsal. All 17 existing-session continuity samples passed across candidate
and restored baseline, including retained-row denial enforcement. Scheduled
cleanup recovered within 45.368 seconds after lock release; exact fixture cleanup
and provider reconciliation passed. This does not establish normal feature or
schema rollout continuity.
[Rollback evidence](evidence/session-denial-refill-continuity-rollback-staging-2026-10-29.json).
The older `0892b28` rehearsal remains historical evidence for its own scope.

Production enablement still requires repeatable capacity margin, pilot-scale
denied-backlog behavior, remaining hosted interruption/password-change
concurrency, physical-device checks, storage/cost acceptance and every active
reader. Existing scoped writer, reader, push, contention and historical rollback
rehearsals are evidence for their stated scope. Do not weaken the independent
privacy journal or treat an unknown commit as complete. Track #1, #9 and #55.

The dated sections below preserve historical implementation and deployment
states; they do not override this current status or the canonical release record.

## Scoped push verification

`deliverWebPush` and `deliverNativePush` contain the same per-delivery denial and
provider-outcome logic used by the normal queue workers. They do not claim jobs,
finish jobs or open a database connection. Their `delivery` argument must be the
session/subscription envelope returned by the corresponding jobs-role
`app.prepare_*_delivery` function under a valid job lease. A caller-provided session
ID alone does not establish subscription or notification authorization. Native
provider credentials are supplied by the normal worker's existing token path.
These are internal functions, not HTTP endpoints or new authorization bypasses.

Local acceptance covers:

- Native workerd execution with an actual local R2 binding: a canonical denial
  suppresses both web/native sends; an independent session reaches only intercepted
  provider transports. Unreadable denial authority causes retry with no send.
- Missing, conflicting, failed and late denial reads. A late read cannot authorize
  a send after its deadline has already produced an unknown result.
- Existing provider redirect/retry behavior and the unchanged normal queue path.
  Both existing SQL suites run against newly created, task-owned disposable local
  databases, including restricted-role preparation and retained SQL session rows.

These are local checks. Provider sends are intercepted; they do not prove hosted
push delivery or physical-device behavior.

Before a hosted enforcement rehearsal, prepare an owner-only manifest listing the
exact synthetic identities, sessions, subscriptions, notifications and outbox jobs,
with source/schema/provider pins and a cleanup ledger. Obtain delivery envelopes
through the real jobs-role preparation functions using only those fixture job
leases. Do not call the shared `claim_push(20)` or `claim_native_push(20)` functions
merely to obtain test work: they can select unrelated notifications.

Use a temporary authenticated operator bound to the intended environment's R2
journal, running the pinned per-delivery helpers. Intercept all provider sends and
return only aggregate outcomes/counts. Verify denied, permitted and unavailable
cases; confirm unrelated session access remains usable. Preserve uncertain writes
for read-only reconciliation. Keep canonical immutable denial objects; scope SQL
cleanup to the manifest and verify it before removing the operator. Do not enable
writer/cleanup flags from this one check: the remaining failure, concurrency,
rollback-reader, device and cost gates are separate requirements.

## Hosted staging push rehearsal — October 29, 2026

[Sanitized evidence](evidence/session-denial-push-staging-2026-10-29.json) records
six successful hosted cases using helpers from source `832b182`. Web and native
push each suppressed a denied session, allowed an independent session through an
intercepted provider transport, and retried without sending when denial authority
was unavailable. Both SQL session rows remained present during enforcement.

Two synthetic members supplied four delivery envelopes through the existing
staging jobs connection and `app.prepare_*_delivery` functions. The migration
connection could not switch to the jobs role; the rehearsal stopped, reconciled
the committed fixture by exact IDs, and continued with the dedicated jobs
connection. It did not repeat fixture creation. Synthetic outbox jobs were held
with `next_retry = 'infinity'` inside their creation transaction, so a process
interruption could not expose them to background claimers. No shared queue claim
function was called in staging.

The expiring, authenticated temporary operator accepted only the pinned synthetic
session/subscription envelopes and one immutable denial record. Native workerd
scope checks passed locally before upload. All provider sends were intercepted;
there were zero actual provider requests. Exact fixture cleanup, operator removal,
and unchanged provider deployment/configuration snapshots were verified. The
canonical denial record remains immutable. Production runtime and the disabled
writer/cleanup flags were unchanged.

This completes the scoped hosted push-enforcement check. It does not demonstrate
physical-device delivery, a production queue end-to-end test, writer/cleanup
interruption recovery, or the monthly availability objective.

## Local logout-route interruption checks — October 29, 2026

The real Hono logout route and restricted PostgreSQL auth connection now cover a
write committing after the four-second publication deadline and cleanup timing out
behind an actual PostgreSQL identity advisory lock. The full auth-journal suite
passed 18 tests against a newly created loopback database, removed afterward.

In the late-write case, the HTTP response is 503 and SQL remains untouched. Once
the immutable denial commits, the old cookie becomes anonymous while the separate
member remains authenticated. The expired HTTP path does not resume cleanup or
repeat publication. The independent sweep deletes the exact session once, then
returns zero deletions on another pass. The global control record stays unchanged.

In the lock-contention case, publication succeeds but SQL cleanup fails within its
configured timeout. The retained SQL row cannot authorize the denied cookie, the
separate member remains authenticated, and releasing the lock permits sweep
recovery. Global control again stays unchanged. These tests exercise real SQL and
HTTP route behavior with an injected in-memory denial store; they do not establish
hosted writer behavior, process-crash durability, or device acceptance.

## Local process-loss acceptance — October 29, 2026

The restricted-session PostgreSQL suite now runs a real subprocess publishing the
production denial helper into native local R2 over a test-only loopback adapter.
After the helper confirms publication, the parent kills the writer with `SIGKILL`
before any cleanup connection exists. The SQL row remains present, but a fresh
SDK session check rejects the denied cookie and accepts an unrelated session.

A separate subprocess runs the production sweep and exact deletion using the
restricted auth database connection. It deletes one session; another fresh process
repeats the sweep and deletes zero. The test verifies one publication, retention of
the canonical denial, and unchanged global control. All 14 restricted-session
integration tests passed. The R2 service stays alive independently of the killed
client, matching the relevant process-loss boundary. This is local native-R2 and
PostgreSQL evidence, not a hosted Worker kill, a storage outage, or a complete
HTTP-request process-kill test. Hosted writer and device gates remain open.

## Integration with current main

The denial branch incorporates main through `ae1d631`, including the confirmed
pre-COMMIT rollback fix and maintained release activation/recovery tooling. The
merge retains `commitAttempted` tracking: only an acknowledged rollback before a
COMMIT attempt proves non-commit; unknown commit and rollback outcomes remain
unresolved. The combined real-PostgreSQL auth-journal and restricted-session suites
passed 36 tests after integration.

This source integration is not deployment authorization for every feature on main.
Compared with the verified live runtime `ebc567a4`, the merged tree also contains
migration 052 and additional application/UI changes not present in that deployment.
A hosted writer rehearsal must pin the actual runtime, asset manifest, schema and
compatible-reader rollback floor, preserve existing deployment settings, and avoid
silently bundling those unrelated features. Writer/cleanup flags remain disabled
until their acceptance gates are met. Reconcile provider state against the canonical
record immediately before any change; this document does not override newer state.

## Capacity and cost checkpoint — October 29, 2026

[Measurements and scoped hosted inventory](evidence/session-denial-capacity-2026-10-29.json)
show three retained records / 246 bytes in staging and one / 82 bytes in production.
Both buckets report Standard storage. Both deployed schedules include the
one-minute cron; the daily backup cron does not enqueue denial cleanup. Inventory
read metadata only, did not read denial bodies or mutate the namespace, and verified
removal of the temporary operators and unchanged application configuration.

Native local R2 measurements of the production sweep:

| Retained records | Pages per full pass | GETs per pass | LISTs / cursor PUTs | Nominal full-pass minutes |
| --- | --- | --- | --- | --- |
| 1 | 1 | 2 | 1 / 0 | 1 |
| 10 | 1 | 11 | 1 / 0 | 1 |
| 11 | 2 | 13 | 2 / 2 | 2 |
| 100 | 10 | 110 | 10 / 10 | 10 |
| 1,000 | 100 | 1,100 | 100 / 100 | 100 |

The test counts cleanup callbacks; it does not measure hosted SQL or queue latency.
The minute column assumes uninterrupted one-minute scheduling, no retries and a
stable record set. A new key behind the cursor may wait for the scan to wrap.
Immediate reader denial is independent of this SQL-cleanup delay. Missed schedules,
retrying pages and continuous growth can increase discovery time.

For 30 days at one successful page per minute, the sweep executes 43,200 pages.
With full pages, it uses at most 86,400 Class A operations (LIST plus cursor PUT),
475,200 Class B GETs, and 432,000 cleanup callbacks. Each already-absent SQL session
still costs five statements, yielding up to 2,160,000 SQL statements in this model.
Current one-page histories require no cursor writes and fewer GETs/callbacks.
Retries and duplicate queue deliveries are additional work, not included limits.

Cloudflare's Standard rates checked October 29 are $0.015/GB-month, $4.50/million
Class A operations and $0.36/million Class B operations. LIST/PUT are Class A;
GET is Class B. Included monthly usage is 10 GB-month, one million A and ten million
B operations; billing rounds to whole units. These allowances are shared with other
account usage. [Official pricing](https://developers.cloudflare.com/r2/pricing/).

The modeled full-page sweep is $0.559872/month at unrounded operation rates before
shared allowances. This is a marginal usage estimate, not an invoice or spending
cap. Add one Class A publication per logout, authorization denial GETs per verified
session lookup, retries, Worker/Queue/database usage and storage. One million retained
canonical records contain about 82 MB of body data; no retention pruning is enabled.
Account-wide billing and non-R2 costs have not been verified here.

That historical four-record inventory fit one page per environment. Later staging
rehearsals add retained denials, so it is not a current inventory. It supported a
bounded staging rehearsal, not unlimited production growth or a cost guarantee.
Before wider writer rollout, measure hosted sweep latency and concurrent traffic;
set an operational history/backlog threshold and demonstrate cleanup discovery
within the chosen bound. Historical rechecks and full-pass delay remain scaling
work tracked in #1. Never expire authoritative denials to solve that problem.

## Hosted staging writer and scheduled recovery — October 29, 2026

[Hosted evidence](evidence/session-denial-writer-staging-2026-10-29.json) records
staging version `57a5c9f2-7d32-447c-bad8-2fc6130163c1`, runtime `ebc567a4`,
with `SESSION_DENIAL_WRITER_V1` and `SESSION_DENIAL_CLEANUP_V1` enabled. Production
retains version `3ee85699-feef-4b0c-b264-d5ff13ab6e94` with both flags disabled.

The maintained inactive-upload and activation commands verified exact executable
and map provenance, unchanged schema and 29 retained public assets. Only the two
staging plain-text flags changed. The dry run caught an overriding metadata block
that initially omitted the flags; the corrected candidate was verified before
upload. Exact runtime/tooling CI passed. Activation completed its synthetic journey
and durable finalization; historical resume reports already finalized.

Two new synthetic members exercised normal logout and an identity-lock timeout.
Normal logout returned 200 in 709 ms, cleared the SDK session cookie, persisted the
canonical denial and removed its exact SQL row. A separate login was then logged
out while its member identity lock was held. The route returned 503, its SQL row
remained, and its cookie was rejected while the other member could still read their
profile. After lock release, polling observed the existing scheduled cleanup remove the
denied row within 25.224 seconds (five-second polling), without a manually
dispatched sweep or deletion. Global privacy
control was active with no pending intents.

An initial verification read through the REST adapter lacked a usable strong ETag.
The completed logout was not repeated. A scoped read-only temporary native-R2
operator reconciled the exact immutable bytes, and the SQL state was checked before
continuing. The strict REST adapter was not weakened. All synthetic accounts and
sessions were removed; their immutable denials remain. Temporary operator removal,
unchanged application state during acceptance, and released deployment lease were
verified. Final staging readiness returned 200/healthy and production monitoring
remained healthy.

This proves the normal hosted writer and one real lock-contention/scheduled-recovery
path. Hosted lost replies, late publication/Worker termination, concurrent password
and session changes, rollback with an uncleaned denial, physical devices and larger
history bounds remain separate gates. Staging enablement is not production
acceptance or evidence that the monthly availability objective has been achieved.

## Local concurrent credential-change acceptance — October 29, 2026

The auth-journal PostgreSQL suite now controls both publication orderings between
logout and password change through the real application auth router:

- Password change commits while logout publication is paused: the password change
  and logout both return 200. The old cookie remains denied, and only the new
  password permits a fresh login.
- Logout publishes and completes after password-change preflight but before its
  journal intent is written: the password change rechecks authorization and returns
  401 without changing credentials. The old cookie remains denied, and only the
  original password permits a fresh login.

Both cases verify another member stays authenticated and global privacy control
is active with no pending intents. All 24 auth-journal tests passed in a newly
created loopback PostgreSQL database, removed afterward. Denial and journal
storage are injected in memory; these are not hosted concurrency results.

The test request helper now gives each request its own `waitUntil` queue, matching
Workers request ownership. Previously the shared test queue could make completed
logout wait for a deliberately paused password-change request. This was a harness
deadlock, not evidence of a deployed application defect. Hosted concurrency,
rollback with retained SQL rows and the remaining production gates stay open.

## Hosted logout / other-session revocation overlap — October 29, 2026

[Scoped hosted evidence](evidence/session-denial-concurrency-staging-2026-10-29.json)
records overlapping requests on staging version `57a5c9f2`, runtime `ebc567a4`.
Two isolated synthetic members and three sessions were used. The primary member's
logout and `revoke-other-sessions` requests started one millisecond apart and were
both in flight for over one second. Logout returned 200; the competing revocation
returned 401. The primary cookie was denied and its exact SQL row removed. Native
R2 readback confirmed the canonical denial.

Because the competing revocation did not complete, the primary member's secondary
session correctly remained usable. A separate member's profile also remained
usable. Both remaining sessions were then logged out and verified revoked before
exact fixture cleanup. Global privacy control was active with zero pending intents.
No password-change or other email-generating action was requested.

The temporary read-only operator was restricted to the three synthetic denial keys,
control readback and disposable CAS probes. Its removal, zero remaining fixture
rows, unchanged deployment/configuration snapshots and released lease were verified.
Final staging readiness was 200/healthy. Production flags were unchanged and off.

This is one observed hosted ordering, not exhaustive concurrency or evidence of
particular server scheduling. The hosted revocation-first success case and hosted
password-change races remain unverified; controlled password-change orderings have
separate local PostgreSQL coverage. Rollback, hosted interruption, device and
history-growth acceptance remain open.

## Hosted rollback with a retained SQL session — October 29, 2026

[Scoped rollback evidence](evidence/session-denial-rollback-staging-2026-10-29.json)
records the maintained activation controller rolling staging candidate `ca9a4b50`
back to baseline `57a5c9f2`. Both use byte-identical runtime `ebc567a4`, unchanged
schema and the same 29 public assets. The candidate changes only the writer and
cleanup flags from true to false; rollback restores both to true.

A real logout encountered an identity lock held only for an isolated synthetic
member and returned 503 after publishing its denial. The SQL session row remained
present. During candidate verification, the old cookie returned 401, the exact SQL
row was still present, and a separate synthetic member returned 200. A hash-pinned
operator preload then injected a local readiness 503 observation to trigger the
controller's automatic rollback. No hosted application fault was introduced.

After provider confirmation of rollback, the same checks again returned 401 for
the denied cookie and 200 for the separate member, with the SQL row still present.
Real readiness, the durable release journey and all public asset hashes passed;
the controller finalized the rollback and archived its lease. The row remained
present until the isolated lock was released. Scheduled cleanup was observed to
remove it within 40.326 seconds, using five-second polling and no manual session
deletion. The denied cookie still returned 401 after cleanup.

Both synthetic members and their session/account rows were removed, and the
cleanup inventory matched the finalized provider snapshot. Final readiness was
200/healthy; production flags remained off and external monitoring reported no
incident. The staging writer and cleanup flags remain enabled on the baseline.

This closes the scoped compatible-version rollback check with an uncleaned denial.
It does not prove rollback to incompatible readers or every future release, hosted
Worker interruption, all concurrency orderings, physical-device behavior, larger
history bounds or monthly availability. Those acceptance gates remain open.

## Hosted successful revocation with overlapping logout — October 29, 2026

[Two additional hosted trials](evidence/session-denial-revocation-overlap-staging-2026-10-29.json)
use the unchanged staging runtime and separate isolated synthetic fixtures. With
revocation launched 250 ms before logout, logout again returned 200 and revocation
401; the secondary session correctly remained usable. A 1,250 ms lead produced
719 ms of request overlap with both operations returning 200. The primary cookie
was denied with its canonical native-R2 record verified, and the secondary cookie
returned 401 with its SQL row removed. An unrelated member stayed usable in both
trials. Global privacy control was active with no pending intents afterward.

All synthetic members and sessions were removed, temporary read-only operators
were removed, and provider snapshots remained unchanged. Final staging readiness
was healthy and the external production monitor reported no incident. No
password-change action or email delivery was requested. Together with the earlier
trial, this supplies hosted evidence for successful revocation and rejected
revocation during overlapping logout. It does not establish internal server
scheduling, exhaustive interleavings or hosted password-change races.

## Denial cleanup monitoring gap

Inspection of deployed runtime `ebc567a4` confirms the denial cleanup queue path is separate from the
normal cleanup path that calls `recordCleanupSuccess`. Its success, invalid-record
and retry events are logged, but `readOperationalHealth` has no denial-sweep
freshness or full-pass-progress check. The normal cleanup heartbeat cannot prove
that denial cleanup is running. This is a confirmed monitoring coverage gap, not
an observed hosted cleanup outage; reader denial remains independent of cleanup.

Before production writer enablement, add a bounded, content-free denial-cleanup
health signal and verify that a stopped or persistently failing sweep is detected
while ordinary cleanup remains healthy. Distinguish page success from full-pass
progress, preserve retry/CAS and compatible rollback behavior, and test startup,
staleness, recovery and concurrent updates. Use measured history size and sweep
progress to set an explicit cleanup-latency bound; do not prune immutable denial
records to satisfy the bound. Track this work in #1.

## Local denial-cleanup progress monitoring — October 29, 2026

The source now implements a separate v2 conditional progress record and protected
readiness integration. [Design, limits and rollout requirements](../design/durable-session-revocation.md#independent-denial-cleanup-health-staging-deployed)
describe the page/full-pass distinction and preservation of the old rollback cursor.
The deployed runtime remains unchanged and does not yet have this monitoring.

Targeted tests verify missing/startup state, page versus full-pass freshness, slow
passes, invalid-record persistence until a clean pass, recovery, SQL failure, lost
progress replies, concurrent CAS losers, malformed/future evidence and bounded
health-body reads. Integration coverage verifies healthy ordinary cleanup cannot
mask stalled denial cleanup and that the SQL connection closes before a stalled
R2 health read times out. All 28 targeted tests passed; the existing database-only
health test was skipped in that run.

All 38 auth-journal and restricted-session PostgreSQL tests passed against disposable
loopback databases. The process-loss case now verifies v2 progress through actual
native local R2 after fresh-process recovery. Temporary databases/roles were removed.
This is local evidence, not hosted health-alert delivery or production enablement.

Full source validation also passed: 22 crypto tests and 1,058 general tests, with
192 environment-dependent tests skipped in the general run. The separate
PostgreSQL run above covers the relevant 38 auth/session tests. API typecheck,
formatting, secret and diff checks passed. Hosted rollout remains pending.

## Operator DNS retry correction — October 29, 2026

The isolated progress release `4b6825e` was uploaded as verified-inactive staging
version `966329b9`. Its bootstrap operator encountered `OPERATOR_DNS_NOT_READY`;
reconciliation verified teardown, no v2 progress record, unchanged application
state and empty activation journals. No activation occurred.

The maintained operator transport now retries only DNS lookup, before constructing
an HTTP request: at most three attempts with 100/200 ms backoff, within five seconds
and the overall request deadline. Lookup time is subtracted from the HTTP budget.
The request is dispatched at most once; transport failure or a lost write reply
never enters the retry loop. A stalled or late DNS result cannot dispatch after
the deadline. TLS hostname/server-name verification remains unchanged.

All ten targeted tests passed: six DNS/dispatch deadline tests and four native-local
R2 operator authorization/CAS/media tests. Formatting, secret and diff checks passed.
Hosted confirmation and the real bootstrap/activation remain pending; this change
is not evidence that the provider's DNS propagation failure has been eliminated.

## Staging progress monitoring deployed — October 29, 2026

[Deployment evidence](evidence/session-denial-progress-staging-2026-10-29.json)
records isolated runtime `4b6825e` activated as staging version `966329b9` through
the maintained controller with tooling `b06179d`. The only application changes
from deployed `ebc567a4` are cleanup progress, the new v2 progress record and
operational-health integration. All 47 bundled first-party sources matched the
commit; schema, frontend, dependencies and retained configuration were unchanged.
The synthetic login/read/logout/revocation journey, readiness and all 29 public
assets passed, and activation finalized with the deployment lease released.

Before activation, the actual v2 sweep completed two pages covering 18 retained
denials with no invalid records. It recorded a seven-second full pass; no completion
timestamp was fabricated. The scoped operator was removed. Earlier preparation
failures were preserved and reconciled before retry: an undefined private-script
scope variable, then a temporary-operator DNS readiness failure. The maintained
DNS-only retry correction passed local and hosted transport checks before use.

After activation, a read-only observer saw both page and full-pass progress newer
than its own start within 46.263 seconds. Five protected-readiness samples were
healthy; the final sample reported a 64-second full pass with 18 records and no
invalid records. No manual sweep ran during this observation, and provider state
remained unchanged. Counts describe the completed scan, not an instantaneous
namespace inventory; keys inserted behind a cursor can require the next pass.

Runtime Verify/secret CI and tooling Verify/secret CI succeeded. Staging retains
both writer and cleanup flags enabled. Production remains on `ebc567a4`, with
both flags off; its external monitor reported no incident. Hosted stalled-job
alert/recovery, rollback of this monitoring release, history-growth acceptance and
remaining writer/device gates are still open. This does not establish monthly
availability or authorize production writer enablement.

## Hosted progress-read failure and notification drill — October 29, 2026

[Scoped evidence](evidence/session-denial-health-failure-staging-2026-10-29.json)
records a bounded failure in staging's v2 operational-progress record. A temporary
operator could access only that exact key and disposable CAS probes; denial and
global-control namespaces were inaccessible. The test saved the original bytes
and ETag privately, conditionally wrote an invalid progress schema, then restored
the exact saved bytes with a conditional write. No timestamps were fabricated.

Protected readiness returned 503 with only `session_denial_cleanup_unavailable`
while ordinary cleanup was 27 seconds old. The real external synthetic probe
failed only protected readiness; login, authorized reads, logout/revocation and
other checks passed. After exact restoration, readiness returned 200, two probes
were healthy, and the shared alert reducer produced outage and recovery events.
A later scheduled full pass completed after restoration with no manual sweep:
117 seconds over 21 observed records, no invalid records. Operator teardown,
unchanged provider state and released lease were verified; production was unchanged.

The existing GitHub relay subsequently delivered both events as clearly labeled
notification drills. Exact bot-authored [outage](https://github.com/porchday/porchday/issues/52#issuecomment-6491483640)
and [recovery](https://github.com/porchday/porchday/issues/52#issuecomment-6491485261)
comments were verified. Dispatch occurred after restoration, so this does not
measure automatic outage-to-notification latency. Owner inbox receipt remains
unverified under #52's `needs verification` label.

The first inline local scope harness failed because a Miniflare worker inherited
`--input-type=module`; the file-based harness subsequently passed authorization,
namespace exclusion, conditional fault/restore and stale-CAS checks. The hosted
result above is independent evidence, not a claim that the initial harness passed.

This verifies a real progress-read failure, independent readiness detection,
recovery and the shared notification path. A stopped scheduler, the three-minute
staleness threshold, a provider storage outage and monitoring-release rollback
were not exercised. History-growth and the remaining production gates stay open.


## SQL-candidate cleanup staging rollout — October 29, 08:43 UTC

[Hosted evidence](evidence/session-denial-candidate-staging-2026-10-29.json) records
isolated runtime `992d24c`, successful required push CI, source-matched artifact,
verified-inactive upload, real native-R2 bootstrap and maintained activation.
Actual v2 work kept the initial rollback baseline fresh; v3 bootstrap examined
three SQL candidates and completed in one second. Activation passed synthetic
login/read/logout/revocation, protected readiness, schema/provider checks and all
29 assets. A separate observer saw fresh scheduled v3 page/full-pass progress
within 43.005 seconds without a manual sweep. All five health samples passed; the
observed pass took one second over three candidates with no invalid records.

This replaces repeated historical-denial enumeration on staging. Denials remain
immutable and authoritative; SQL is candidate discovery only. No production
writer or deployment change occurred. Hosted monitoring rollback, stale-job
alert/recovery, larger live-session capacity, remaining interruption/concurrency
and device gates remain open. Old v2 progress becomes stale when its sweep stops;
a delayed v2 rollback needs actual fresh v2 work, never borrowed v3 timestamps.


## V3 monitoring rollback rehearsal — October 29, 08:54 UTC

[Hosted evidence](evidence/session-denial-candidate-rollback-staging-2026-10-29.json)
records the automatic rollback from candidate `8acc78df` to `7469d433`, both using
runtime `992d24c`. Only the candidate writer/cleanup flags changed to false; no
application code, schema, frontend or production change occurred.

A synthetic logout published its immutable denial while an identity lock kept its
SQL session row present. Candidate and restored-baseline checks both rejected the
denied cookie with 401, observed the retained row, and allowed another synthetic
member with 200. A locally injected failed readiness observation triggered the
controller's real provider rollback; this was not a hosted readiness outage.
The restored baseline's actual readiness response had healthy, non-null v3 progress.
Durable journey, schema/provider and all 29 asset checks passed before finalization.

After lock release, scheduled cleanup removed the row within 45.343 seconds
(five-second SQL polling), without manual session deletion. Actual scheduled v3
full-pass completion followed, taking one second over five candidates, with no
invalid records or issues. Exact synthetic fixture cleanup left zero user, member,
account or session rows; immutable denials were retained and the lease was released.
Production remained unchanged and its external monitor was healthy afterward.

This closes the scoped v3-compatible monitoring rollback check. It does not cover
every future feature/schema change or provider outage. Delayed rollback to v2 still
requires actual fresh v2 progress. Stale-job alert/recovery, larger live-session
capacity, remaining hosted interruption/concurrency and device gates stay open.


## Real cleanup staleness and alert recovery — October 29, 09:08 UTC

[Hosted evidence](evidence/session-denial-stale-staging-2026-10-29.json) records a
bounded identity lock on one synthetic denied session in staging. Scheduled
cleanup could not advance past the locked deletion; actual page progress aged
past 180 seconds without editing timestamps. Protected readiness returned 503
with `session_denial_cleanup_stale` at page age 189 seconds. Ordinary cleanup
remained fresh, and all other synthetic journey checks passed. The denied cookie
remained rejected while its SQL row was retained.

The Mac staging loop used the shared probe, alert reducer and GitHub relay. The
exact bot-authored [outage comment](https://github.com/porchday/porchday/issues/52#issuecomment-6492523837)
was verified 24.037 seconds after the failed observation, while the lock was
still held and readiness still failed. After lock release, scheduled cleanup
removed the row and completed a new full pass without manual sweeping. Two
consecutive healthy probes established recovery at 60.014 seconds after release;
the exact [recovery comment](https://github.com/porchday/porchday/issues/52#issuecomment-6492551626)
was verified 16.785 seconds after that observation. These are observed readback
latencies for this drill, not guaranteed notification deadlines.

The fixture was removed with zero remaining user/member/account/session rows;
immutable denials were retained. Provider state and production were unchanged,
the deployment lease was released, and the production monitor remained healthy.
Preflight passed 25 monitoring/health tests and verified a single lock release
when watchdog and normal cleanup race.

This closes the scoped real-staleness/alert/scheduled-recovery check. It did not
stop the scheduler or simulate a provider outage or Mac host loss. Owner inbox
receipt remains unverified in #52. Larger live-session capacity, hosted
interruption/concurrency, device checks and the other production gates remain open.


## Multi-page live-session observation — October 29, 09:17 UTC

[Hosted evidence](evidence/session-denial-live-capacity-staging-2026-10-29.json)
records 250 unexpired, non-denied SQL sessions for one synthetic staging member
on unchanged runtime `992d24c`. Two actual scheduled full passes covered 253
sessions each and took 124 and 123 seconds. Intermediate progress was observed
at 100 and 200 candidates; no manual sweep or progress write occurred. All 18
external journey observations passed, all 250 fixture sessions remained present
until exact cleanup, and maximum observed page/pass ages were 47/167 seconds.
Observed logout median/max were 663/837 ms; these sparse samples are not a latency
SLO or a concurrent-user benchmark.

The fixture was removed with zero remaining rows, provider and production state
were unchanged, and the deployment lease was released. One aggregate database
snapshot during the run saw seven server connections against a configured limit
of 25, zero idle-in-transaction connections; it does not measure peak headroom.

This is evidence for multi-page discovery at this population. It does not test
10,000 users, concurrent requests, a large denied-row backlog or provider failure.
The current 100-candidate/minute cadence cannot satisfy the five-minute full-pass
deadline at 10,000 live sessions. A bounded, checkpoint-token continuation change
has local control-flow tests; hosted throughput and rollback verification for
that change remain open before promotion. Do not loosen health thresholds to
make a large-population scan appear healthy.


## Continuation rollout and measured comparison — October 29, 09:33 UTC

[Release evidence](evidence/session-denial-continuation-staging-2026-10-29.json)
records isolated runtime `2ab27b5`, green required push CI for runtime and tooling,
48 source-matched bundled files and a verified-inactive upload. The first
activation plan was rejected at lease acquisition because it omitted the recorded
denial-reader floor. Its empty journal, absent lease and unchanged provider state
proved no deployment mutation occurred; the failed plan and bot alert remain
preserved. A separately reviewed plan acknowledged the floor while retaining
`7469d433` as its actual rollback target, then completed maintained activation.
Journeys/readiness, schema/provider and all 29 assets passed. Seven healthy
post-activation samples observed actual scheduled full-pass advancement within
66.241 seconds, without manual sweeps. Production remained unchanged.

The [subsequent capacity comparison](evidence/session-denial-continuation-capacity-staging-2026-10-29.json)
seeded the same 250-session fixture size. Two scheduled passes over 253 candidates
completed in 12 and 18 seconds, versus 124 and 123 seconds with the previous
one-page-per-minute runtime. All seven journey samples passed; maximum observed
page/full-pass age was 59 seconds. All 250 non-denied sessions remained present
until exact cleanup, which left zero fixture rows. Provider state was unchanged
during observation and the lease was released.

These successive small-population runs demonstrate removal of the cron wait
between pages; they do not establish throughput for 10,000 sessions, a large
denied backlog, concurrent-user load or overlapping release traffic. Queue
scheduling and per-page work still contribute to full-pass duration. Larger-load
measurement and compatible rollback of the continuation change remain gates,
along with the other writer acceptance requirements. Production writers stay off.


## 10,000 live-session deadline failure — October 29, 09:42 UTC

The [larger staging observation](evidence/session-denial-10k-capacity-staging-2026-10-29.json)
failed on continuation runtime `2ab27b5`. With 10,000 unexpired non-denied fixture
sessions, twelve journey samples passed before protected readiness returned 503
with `session_denial_pass_stale`. At failure, page age was two seconds, last full
pass age 302 seconds, current pass count 9,000 and invalid count zero. Ordinary
cleanup age was one second; every other journey check passed. All 10,000 fixture
rows remained intact. This demonstrates that fresh pages alone do not establish
acceptable full-pass throughput at the planned population.

The bounded test removed only its fixture and verified zero remaining rows.
Scheduled cleanup recovered without manual sweeping; three healthy observations
followed, including a fresh one-second pass over the remaining three sessions.
The intervening 9,200-observation completion after fixture removal is not a
successful 10,000-session scan. Provider state was unchanged, production was not
mutated and the lease was released. The failed sample remains in the evidence;
no health threshold or probe deadline was increased.

A local follow-up batches at most five existing 100-session pages within one
shared 20-second work-start budget, checkpointing each page before proceeding.
It stops on full-pass completion, stale token or CAS loss, and returns the last
confirmed continuation when the page/time bound is reached. Each SQL/R2 deadline
and denial-authority check remains in place. Native process-recovery tests now
exercise this batch helper. This change is not yet deployed or hosted-validated.

## Hosted bounded denied backlog — October 29, 2026

[Evidence](evidence/session-denial-backlog-staging-2026-10-29.json) records six real
logout requests under one synthetic member's identity lock, with at most two
requests in flight. Each returned the expected 503 from blocked SQL cleanup.
Every original cookie then returned 401 while all six SQL rows remained present.
The unrelated synthetic member remained usable, and protected readiness stayed
healthy. The test respected existing auth rate limits and changed none of them.

The lock was held for 21.594 seconds. After release, scheduled cleanup removed all
six denied rows within 27.923 seconds; no manual sweep or denied-row deletion
contributed to that acceptance. All old cookies still returned 401 afterward.
Exact fixture cleanup verified zero rows for both synthetic members, immutable
denials were retained, and provider/canonical state was unchanged. The deployment
lease was released; there were no production mutations.

This completes a bounded multi-session backlog recovery rehearsal on the current
runtime. It does not prove a pilot-scale denied backlog, hosted Worker termination,
password-change races, physical-device behavior or monthly availability. Reader
outcomes with retained SQL rows are the authority-enforcement evidence here;
the test did not fetch denial object bodies directly.

## Current six-read runtime rollback — October 29, 2026

[Sanitized evidence](evidence/session-denial-six-read-rollback-staging-2026-10-29.json)
records a completed staging rehearsal on runtime `0892b28`, with `d06996e3` as
the restored baseline. The inactive candidate retained identical executable,
schema and 31 public assets, changing only writer/cleanup flags to disabled.
A locally injected failed readiness observation triggered actual provider rollback.

A real logout published a denial while a synthetic identity lock retained its SQL
row. The original cookie returned 401 on the candidate and restored baseline;
the unrelated member returned 200 on both. Actual readiness after rollback was
healthy with non-null v3 progress. Once the lock was released, scheduled cleanup
removed the retained row within 15.147 seconds, and a new full pass completed.
No manual sweep contributed to acceptance. Exact fixture cleanup verified zero
rows, immutable denials remained, provider state reconciled and the lease released.
Production was unchanged.

This refreshes the scoped rollback evidence for the current runtime. It does not
establish safety for arbitrary feature/schema changes, a provider outage, delayed
legacy-reader rollback, physical devices or the monthly availability objective.
