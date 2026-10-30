# Isolated cleanup: combined staging trial passed

Runtime `4ef4237771cdc9ab8194a220fdb649edc3cdf38e` passed the
10,000-live/400-denied staging workload with isolated range queues. This is
bounded staging evidence, not production capacity certification or measured
99.99% availability. The [earlier shared-queue failure](denial-partition-combined-staging-2026-10-29.md)
remains preserved, including its missing failed-cycle observation.

## Deployment and admission

Staging activated `00939b98-6cb4-4ad9-8441-1bc2584c4c5a` at 22:39:28 UTC
on October 29. This reused the exact verified runtime bundle and changed only
the topology flag. All three range producer bindings were already present.
Ordinary and range queues each had one consumer, batch size one and concurrency
one. Range delivery was enabled through separate verified operations.

Activation recorded 12 continuity samples, zero failures and two post-terminal
samples. Existing allowed sessions remained valid; revoked cookies stayed
rejected. Exact activation-fixture cleanup reached zero, provider inventory
matched the canonical record and the shared deployment lease was released.
Production runtime and writer/cleanup/partition flags were unchanged.

Live provider reads confirmed both environments retained one transaction-pooler
process, four backend connections per role, twelve per database, zero reserve
and a five-second client queue timeout. All six runtime Hyperdrive routes still
used port 6432 with caching disabled. No database tier, replica or pooler settings
changed. Queue client-pool maxima total eight; this is not an eight-backend
occupancy claim. Authentication requests share the auth backend allocation with
queue work.

## Idle baseline and workload

Normal cron and monitoring continued. No synthetic queue work was injected to
warm concurrency. Seven pre-workload observations established four consecutive
quiet readings, fresh range passes begun after activation cleanup, and only
three sessions seen in the preceding completed passes. The idle gate passed
126.9 seconds after activation cleanup.

Queue readings used the [Cloudflare queue metrics endpoint](https://developers.cloudflare.com/api/resources/queues/methods/get_metrics/).
These are best-effort, approximate values; zero readings alone do not prove
there was no in-flight work. The gate combined them with fresh persisted range
progress and the bounded normal-session baseline.

At 22:42:55 UTC, the harness seeded 10,000 distinct synthetic users, one live
session per user and 400 additional denied sessions with interleaved random
identifiers. Immutable denial records were written and verified before SQL
seeding. The fixture generation and SQL statements retained the previously
validated workload. Cleanup used normal scheduling and continuations.

| Observation | Result |
| --- | ---: |
| Completed workload samples | 10 |
| Live sessions retained in every sample | 10,000 |
| Denied sessions remaining at acceptance | 0 |
| Observed drain duration | 184,093 ms |
| Margin under the 240-second target | 55,907 ms |
| Maximum observed journey duration | 2,598 ms |
| Maximum observed page age | 47 seconds |
| Maximum observed full-pass age | 188 seconds |

All journeys and protected-readiness checks passed. All three completed passes
used for acceptance began after seeding. The ten-second journey, 180-second page
and 300-second full-pass limits were unchanged. The 240-second drain target was
an additional margin requirement. The harness saved partial or failing reads
before applying acceptance assertions.

## Connections and ordinary work

A separate read-only observer sampled server-wide client connections every five
seconds during the workload, adding at most one operator connection. All 39
observations succeeded. Observed maxima were eleven total clients and six
application clients; role maxima were auth three, social two and jobs one.
These sampled maxima are lower bounds on actual peaks, and separate role maxima
must not be added as a simultaneous total. Superusers were classified separately
from application roles.

Application telemetry for 22:42:55–22:46:06 UTC returned three ordinary cleanup
completions and 27 denial-cleanup completions totaling 400 deletions. No error or
connection-refusal rows appeared in those returned aggregates; sampled telemetry
does not prove that no brief errors occurred. Paired authority timing recorded
778,579 occupied slot-ms out of 928,238 available slot-ms, approximately 83.9%.
Independently sampled phase totals are not additive and are not billing evidence.

## Cleanup, recovery and limits

Exact owned SQL cleanup verified zero remaining fixture rows at 22:46:06 UTC.
Immutable denials were retained. Five recovery observations culminated in fresh
passes begun after cleanup, journal publication through sequence 30,672 and at
least two healthy post-cleanup journeys. At 22:47:31 UTC the original operation
completed successfully with unchanged provider inventory and its lease released.
No seeding or cleanup operation was replayed.

Local harness checks covered eleven workload-observer cases, eight production
guards, nine idle-loop cases and 21 backlog-reader cases, plus unchanged SQL and
fixture compatibility. The first idle test used an invalid zero timestamp; the
test fixture was corrected to a positive timestamp without relaxing the runtime
gate. Exact runtime and tooling CI had passed before deployment.

## Controlled return and restoration

After workload cleanup and recovery, a configuration-only return to shared
delivery completed at 22:49:26 UTC as
`118692ca-14b7-444d-9ada-c2d6d552374a`. Its eleven continuity samples had zero
failures, including two post-terminal samples. Allowed/revoked sessions behaved
correctly and exact fixture cleanup reached zero.

The exact isolated configuration was restored at 22:51:40 UTC as
`91a0bea2-1327-4806-9c46-dddc1e8133d4`, again using runtime `4ef4237`.
Twelve continuity samples passed with zero failures and two post-terminal
samples. All queue identities, bindings and cap-one settings remained unchanged;
fixtures reached zero and provider/canonical reconciliation released the lease.
Production remained unchanged throughout both transitions.

This demonstrates a controlled compatible return and restoration. It is not a
new fault-injected automatic rollback test. The workload was not repeated merely
to obtain another passing result after restoring identical code/configuration.

This result establishes one successful bounded idle-to-burst rehearsal. It does
not certify arbitrary load, sustained throughput, provider failover, physical
devices or production rollout. Remaining concurrency/security/device gates are
separate acceptance work. Keep #9 open and PR #90 draft until their full criteria
are verified. Tracks #9, #42 and #55.
