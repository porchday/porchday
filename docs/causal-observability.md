Owner authorized active implementation on November 9, 2026: upgrade production monitoring/logging and causal tracing across browser/encryption, API, database, storage, jobs and infrastructure.

Plan
1. Establish W3C trace/span identity with async-local parentage, release/environment/service labels, request outcome and finite error classifications. Preserve consent for device diagnostics; never collect plaintext, keys, tokens, raw SQL/parameters, storage keys, email addresses or raw URLs in operational telemetry.
2. Instrument dependencies and journal retry attempts, transaction boundaries, queue send/receive, cron, background completion, media/storage reads and body consumption. Distinguish timeouts from cancellation and late completion. Record observable dependency latency without claiming visibility inside provider infrastructure.
3. Retain bounded error/slow traces and sampled normal traces independently of browser uploads. Add explicit retention, byte/span/concurrency budgets, export failure/drop counters and ingestion health checks. Provide restricted query/export tooling and incident links. Use the existing Cloudflare infrastructure and first-party investigation tools, as selected by the owner.
4. Correlate opted-in browser network, encryption/decryption, decode and rendering with server spans. Give synthetic probes trace correlation and distinguish transport failures from failed HTTP responses and skipped dependent checks. Maintain independent incident dispatch with no recurring AI polling.
5. Add actionable dashboards/query views for request errors/latency, journal retries/recovery, connection occupancy, queues/cron freshness and telemetry pipeline health, with concrete incident evidence queries.
6. Verify privacy and bounded overhead, concurrency/context isolation, lost replies/late completions, background jobs, exporter failure, and controlled dependency failures. Deploy through exact-source CI, native parity, staging and production continuity gates. Verify stored traces for real synthetic journeys and error drills; measure overhead. Close only with production evidence, explicitly documenting external-provider blind spots and device-only validation.

No paid subscription or third-party content export is authorized by the implementation itself. Existing #8, #9, #55 retain their operational findings; this issue owns the tracing/observability upgrade.

## Selected implementation

The owner selected **Cloudflare with first-party investigation tools**, not Datadog. Operational traces use the existing TRACES D1 database in a separate `operational_traces` table; consented content stays in its existing separate recordings. Native provider invocation logs remain disabled because automatic request metadata can include sensitive URLs. The new records are structured production evidence, not console dumps.

A trace has W3C trace/span IDs, explicit parents and queue-producer links, environment/service/release, response duration, lifecycle duration, finite dependency/phase names, SQLSTATE or finite error classifications, and bounded connection snapshots. No raw SQL, SQL parameters, storage keys, member identifiers, credentials, plaintext, content hashes or provider error messages are included. Browser work remains opt-in. In-memory provenance connects response JSON to decryption/decoding and sealed data to a later write; provenance is not embedded in ciphertext or member records and is cleared when recording stops.

The public edge measures service-binding transit; the API records request phases, PostgreSQL pool acquisition/query/transaction/close, R2 metadata/body methods and native stream handoff, D1 calls, journal attempts/backoff and late completion, email/push calls, cron and linked queue batches. Queue links describe contributing producers, not an invented unique causal parent for coalesced cleanup. Connection snapshots give observed infrastructure state, not a claim that occupancy caused a request failure. Provider-internal execution, network hops and native OS work outside the shared web view remain opaque unless the provider/device supplies evidence. A transport deadline does not prove server cancellation.

Normal traces are sampled consistently by trace ID at 5%; slow lifecycles (at least two seconds) and observed errors are retained regardless of that choice. Cron is retained to establish collection freshness. At most 160 spans and 32 producer links are stored per root, with omitted spans and producer links counted. Each isolate allows four concurrent exports, twenty exports/second and a burst of forty; snapshots are coalesced during late work. The export cap is 64,000 serialized characters, seven-day logical retention, daily deletion, indexed lookup. This is an overload guard, not an account-wide billing ceiling. Collection failures/drops have independent Analytics Engine counters; storage failure cannot block or retry an application operation.

`/operations/traces` is the investigation UI. Its API requires verified Cloudflare Access plus an active builder staff role and persists an access audit before reading evidence. It joins operational roots, queue links and consented client request/crypto measurements by trace ID. During an application/database incident, use the read-only operator CLI directly against D1; it does not depend on the application's journal/auth path:

```
npx tsx scripts/query-causal-traces.ts production recent
npx tsx scripts/query-causal-traces.ts production trace <32-hex-trace-id>
npx tsx scripts/query-causal-traces.ts production errors
npx tsx scripts/query-causal-traces.ts production health
npx tsx scripts/query-causal-traces.ts production otlp <32-hex-trace-id>
```

The OTLP command produces local JSON for interoperability; it sends nothing to a third party. Pending spans are explicitly unfinished and must not be interpreted as successful/cancelled. OTLP exports them as unfinished-observation events, without invented end times. Native R2 streams are passed through unchanged: handoff is recorded, while client Resource Timing measures transfer. Server-side handoff does not establish full delivery or cancellation. Root lifecycle time can include background work after the HTTP response; the separate response duration is the appropriate server-response measure. Client durations use the client clock; do not subtract browser and server wall clocks to invent network latency.

Enable with `operational_tracing: true` in the environment resources only after D1 migration 0003 and staging verification. Render API, edge and monitor configuration. The monitor's existing telemetry-alert channel also checks causal ingestion: a successful export within five minutes and no sustained losses (at least five losses and at least 1% of exports in the queried window). Three failed polls alert; two healthy polls recover. Export counters are sampled/best effort, so local counters and stored records must be reconciled during acceptance. Application metrics, synthetic outcomes and tracing health are distinct evidence.

## Rollout acceptance still required

Before enabling production: exact-source web/API/monitor tests and native builds; real PostgreSQL driver behavior; native Workers R2/D1 behavior; denied operator reads/audit failure; synthetic staged request -> storage/database -> browser crypto -> write and cron -> queue correlation; intentional staging-only exporter failure and recovery; latency/volume comparison; preserved logout/revocation continuity. Record exact deployed versions, ingestion/retention checks, monitor bundle changes and remaining device/provider limitations here and in #12. Implementation alone does not satisfy this rollout acceptance.

## Local validation

November 9: full local suite passed (1,345 passed, 326 environment-dependent skips); typechecking passed. Additional real PostgreSQL tests passed for both lazy tagged queries and callback-driven pool queries. A local Workers runtime exercised receiver-sensitive R2 operations, native stream framing and D1 prepared/batch operations and persisted the resulting trace. Chromium and WebKit verified detailed-diagnostics-only response → decrypt → encrypt → write correlation and provenance clearing on stop. The investigation UI was exercised with synthetic evidence at desktop and phone widths. These checks do not substitute for hosted rollout evidence.

The export format follows [OTLP JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding). Cloudflare D1 charges include index maintenance as well as table writes; budgeting must use actual D1 row metrics, not only the number of retained traces. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). Seven-day expiry and per-isolate budgets limit ordinary ingestion, but do not guarantee a global spend ceiling during distributed overload.

Native R2 stream identity is deliberately preserved. A generic ReadableStream wrapper changed known-length responses to chunked encoding in the local Workers check; it was removed before deployment. See [Cloudflare response framing](https://developers.cloudflare.com/workers/runtime-apis/response/#set-the-content-length-header).
