# Isolated journal storage prototype

This investigates the R2 round-trip cost recorded in issue #9. It is **not an
application backend**. There is no application binding, deployment configuration,
public route, migration, deletion operation, or real journal access. The default
Worker returns 404. Tests call the isolated Durable Object through a local binding.

The prototype stores exact synthetic strings with version tokens. Creation requires
an absent-key precondition; updates require the current token. A synchronous SQLite
transaction encloses each check/write, followed by an awaited storage sync before
success. Conflicts return null. Storage failures return 503; callers must reconcile
an uncertain write by reading, never assume rollback or replay application work.
Only synthetic key prefixes are accepted, with 64 records and 32 KiB per value.
These deliberately small probe limits are not production journal capacity limits.

Run locally with the repository's locked dependencies:

```sh
npx --no-install tsc -p experiments/journal-store/tsconfig.json
node --import tsx experiments/journal-store/check.mjs
```

The harness uses workerd/SQLite via Miniflare supplied by the locked Wrangler tool.
It checks exact bytes, immutable conflicts, 12 competing CAS writes (one winner),
a discarded successful reply and safe conditional replay, persistence after runtime
restart, malformed conditions, size/capacity refusal, and retained committed data.
It creates and removes its own temporary storage directory. No hosted traffic or
credentials are used. The initial harness persistence check failed because the
legacy configuration converter omitted persistence; explicit resourcePersistencePath
fixed the harness. Keep this failure distinct from a storage durability failure.

Passing these checks does not prove crash/power-loss durability, hosted latency,
recovery equivalence, or any p99 target. The hosted durability fence must be checked
against provider guarantees and fault behavior. Restore/export, immutable-chain and
receipt proof, old/new reader compatibility, capacity, migration and safe rollback
remain required before any application use. Never fall back from this store to a
stale R2 checkpoint. The existing R2 journal remains authoritative.

Local fault fixtures use separate test-only classes to fail after SQL insertion
inside the transaction and at the durability fence. The checks distinguish rollback
from an uncertain committed write, require 503 without diagnostics, and reconcile
by reading. These injected failures are not provider crash/power-loss evidence.
Streaming request bodies are bounded before parsing.

The harness also runs the existing privacy-journal algorithm unchanged through a
synthetic-key adapter: concurrent intents/completions, independent intent/receipt
records, rollback rejection, and immutable-chain verification. This exercises
protocol compatibility locally, not migration or operational recovery. The fault
fixture module must never be deployed.
