# Auth commit recovery: pre-migration backup compatibility

Local acceptance on 2026-10-30 for #1 and #42, draft PR #92.
Runtime source: `c760c9af84febbce3b4673a15db011ba16aeeb9f`.
Drill: `scripts/drill-restore-local.ts --run --commit-protocol`.
Executed drill SHA-256: `60bd2d63a785635f3831df3882333877f581cf18abd2b9d53021d50d674dad82`.

The drill passed with a real PostgreSQL 17 custom-format dump and restore into
a separate database, plus persistent native local R2 storage. The source backup
was taken before migration 057; the restored target initially lacked its table
and functions. Migration 057 was then applied before journal replay.

The new source committed an auth transaction without a completion receipt.
The active recovery path exported and proved its marker, published an ordinary
v1 receipt and retired pending bookkeeping. The stale threshold was advanced
with a local test clock; this is not measured recovery latency. The independent
journal was closed and reopened from persistent storage before restoring.

The restored database rebuilt the missing terminal marker and unique fence.
Replay preserved the credential hold, removed restored sessions, reset tokens
and integration grants, discarded deleted/expired/obsolete encrypted content,
and retained two valid posts. Surviving encrypted content and media decrypted
correctly. Media cleanup failure kept quarantine active; the subsequent retry
succeeded. Release still required verification of live media.

The actual journal reader and wrapper from
`3810d1d6383415eb2559c54829b68dee6113618c` were loaded from a Git archive and run
against the expanded source schema and released restored target. Dependencies
were unchanged between that source and the current runtime. This verifies the
journal component, not an entire old Worker deployment or browser session.
The old SQL restore function explicitly rejected the new marker before 057 was
applied, demonstrating why restore tooling must retain that schema floor.

Final run: 18 events replayed, one object deleted, one credential hold retained,
2,438 ms total drill duration. Terminal exit was zero; both owned fixture
databases were absent afterward and the dedicated container was removed. This
is a disposable local drill, not a hosted-provider backup or recovery-time SLO.

Production and staging were unchanged. Both commit protocol flags remain
absent from provider configurations. Hosted staging interruption/recovery,
request bounds under load, and compatible Worker rollback are still required
before enabling the writer. The monthly availability target remains unproven.
