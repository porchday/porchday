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
Only synthetic key prefixes are accepted, with 64 records and 256 KiB per value with a 2 MiB streamed request cap.
These deliberately small probe limits are not production journal capacity limits.

Run locally with the repository's locked dependencies:

```sh
npx --no-install tsc -p experiments/journal-store/tsconfig.json
node --import tsx experiments/journal-store/check.mjs
node experiments/journal-store/check-hosted.mjs
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

## Bounded hosted-controller preparation

`hosted.ts` is a separate, undeployed experimental controller. It requires a secret
Bearer token, fixed synthetic run ID and an expiry at most 15 minutes away. A durable
create-only latch allows exactly one run even with concurrent invocations or a lost
reply. The sequence is five reads and six writes, plus setup/lease/result records.
Each internal request has a deadline of at most 10 seconds and cannot start after
expiry. No application content, database calls, real journal paths, region claims
or p99 claims are involved. The outcome and numeric durations are persisted for
authenticated read-only retrieval while the controller remains valid. A committed
latch with no result is unresolved evidence; never reset it and replay the run.

The controller harness verifies authentication, expiry without consuming the latch,
concurrent single use, exact operation counts, durable result retrieval and an
uncertain lease response preventing replay. It runs locally and does not provision
or expose a hosted endpoint. Deployment requires fresh CI, isolated bindings, a
short fixed deadline, private credentials, and provider-state/cleanup verification.
The result measures a storage operation shape, not the complete journal protocol or
end-to-end user action. Real hosted speed, durability and recovery remain unverified.

## October 29 hosted diagnostic evidence

Exact source `3513f8d` passed full CI (40795261566) before either isolated deployment.
The first single-use probe's Python urllib POST returned 403; a read-only result
lookup also returned 403 with Cloudflare code 1010. No POST was replayed, and no
latency result was accepted. Its endpoint, synthetic namespace and Worker were
removed and the original inventory verified before the next independent probe.

A fresh deployment used an isolated Chromium 156.0.8078.4 browser with its normal
client identity, no member profile, and network interception restricting it to one
POST. Security settings were unchanged. From 00:44:19.015 to 00:44:19.303 UTC the
Worker measured the synthetic sequence below, with every operation successful:

| Operation | Durations | Total |
| --- | --- | ---: |
| Five reads | 14, 14, 14, 13, 16 ms | 71 ms |
| Six writes | 31, 31, 27, 30, 38, 30 ms | 187 ms |
| Measured storage sequence | | 258 ms |
| Setup plus sequence | | 288 ms |
| Browser request through consumed response | | 700.1 ms |

This is one observation on a fresh namespace, using tiny synthetic strings.
The durable lease happens before measured setup, so the 288 ms interval is **not**
a cold-object or complete-request metric; it also excludes the final result write.
The browser interval includes those operations and network transit. Neither is a
complete application edit: authentication, database work, real checkpoint payloads,
encryption, recipient lookup and client rendering are absent. Region, actual object
placement and network conditions are unverified. No p99 or mobile claim follows.
The result supports further investigation, not replacement of the R2 journal.

After collecting evidence, the endpoint was disabled, the owned synthetic namespace
and Worker removed, and the original six-Worker/two-namespace inventory and existing
application provider state verified. The deployment lock was released. No production
request or application binding changed. Failed and successful evidence are retained
separately in the primary checkout's private `journal-store-hosted-20261029` and
`journal-store-browser-20261029` artifact directories; credentials were not copied
into either archive. Hosted crash durability, restore/migration/rollback compatibility,
realistic payload/concurrency performance and all original acceptance gates remain open.

## Larger-record compatibility checks

A 200-event reaction-deletion checkpoint generated from the current SQL decision
shape was rejected by the original 32 KiB/64 KiB prototype limits. After increasing
the bounded value/request capacities, the unchanged journal algorithm verifies
that 78,800-byte batch, concurrent completions and its immutable chain locally.
Boundary checks preserve exact 256 KiB NUL/escaped and multibyte strings and reject
an over-limit UTF-8 value without overwriting committed data. This does not prove
that every possible journal record fits: the prototype remains deliberately bounded,
and production migration still requires a complete record-size/capacity policy.

The next hosted controller uses a synthetic 200-event batch and control documents
with 255 existing/256 registered pending intents, plus schema-shaped intents and
receipts. It retains the same five-read/six-write budget, verifies control read-back
bytes, and reports numeric record sizes. These shapes exercise payload cost, not
255 live concurrent operations or the full production protocol. The tiny-string
measurements above remain labeled as such; larger-record hosted evidence is pending.

Receipt-recovery checks additionally interrupt the final retirement write after
an immutable receipt is stored. With the unchanged journal reconciliation code,
a valid receipt's checkpoint ancestry permits clearing the stale pending intent;
a receipt with a forged generation is rejected and the pending intent remains.
These are local injected failures with synthetic records, not hosted crash or
operational restore evidence.
