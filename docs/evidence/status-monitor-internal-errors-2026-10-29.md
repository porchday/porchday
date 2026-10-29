# Status monitor internal errors and bounded read recovery

A read-only production-monitor log session from 14:24:58.888 to 14:26:34.311 UTC
on October 29 captured public Worker 503 responses at 14:25:54.072 and
14:26:14.068, each accompanied by a Durable Object exception whose message was
`internal error` with a provider reference. A scheduled invocation at
14:26:22.815 also had a Durable Object internal-error event. References and raw
logs are retained privately for provider investigation. No production mutation
or deployment occurred during collection. The tail process exited successfully.

A separate bounded public read observed two 503/unknown responses followed by
two operational responses with a roughly 52-second-old observation timestamp.
Earlier external monitor evidence showed application login/read/logout/readiness
passing while status freshness failed. These observations locate specific
failures in the monitor's Durable Object path, but do not establish the provider's
underlying cause, explain all earlier failures, or prove general platform impact.

## Candidate mitigation

The public status read now makes at most two attempts, with a fresh Durable
Object stub and 100–199 ms backoff for the second attempt. Only an exception with
`retryable === true` and without `overloaded === true` qualifies. HTTP failures,
unclassified errors and overloads are not retried. A three-second total deadline
includes response-body reading; response bytes are capped at 16 KiB. The response
body is consumed before transport cancellation so successful responses remain
readable. Stalled body reads are canceled on deadline. Error logging contains
fixed phase codes and boolean flags, never raw exception messages, headers or
member data. Storage-read failures receive a separate fixed diagnostic code.

This follows [Cloudflare's Durable Object error-handling guidance](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/).
Scheduled ticks, alert delivery and storage writes do not use the retry helper.
The existing freshness deadline and persisted history are unchanged. Read retry
cannot repair missing scheduled observations and is not a claim that the
underlying incident is resolved.

All 40 monitor tests passed, including real local workerd/Durable Object checks,
retry classification, overload refusal, fresh-stub acquisition, maximum attempts,
HTTP failure behavior, body-size bounds, stalled transports/body deadlines and
secret-free diagnostics. Monitor TypeScript checks and diff whitespace checks
passed. An initial workerd test caught cancellation of a returned streaming body;
the final implementation consumes the bounded body before canceling transport.

The change has not been deployed. Next gates are exact-source CI, isolated
staging monitor upload/activation with current inventory and preserved state,
hosted verification of normal and failed reads, and review of scheduled tick
failure/recovery without replaying uncertain side effects. Issue #8 remains open.
