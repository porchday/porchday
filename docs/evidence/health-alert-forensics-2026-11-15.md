# Health-alert forensics — November 15

Status: implementation and validation in progress; not yet deployed by this work.

Issue #52 contains distinct confirmed failure/recovery transitions, not duplicate delivery of the same event. Three failure classes are visible after the November 12 logout release:

* November 13: correlated journal safety-status database reads exceeded the guard deadline. The database/pool/provider-internal cause is not established by those traces. This is not evidence that the revocation operation itself was slow.
* November 14 around 19:41–20:05 UTC: R2 GET errors and failed logout publication/reconciliation. Global journal reads already retried, while independent session-denial and cleanup-health reads were single-shot. A failed logout acknowledgement does not establish revocation of that request's cookie.
* November 15 at 08:04 and 16:06 UTC: headers deadlines also affected independent status/readiness requests; dependent profile/logout/revocation checks were often skipped. For 16:06, Mac kernel evidence shows five connections established in about 5 ms, then zero incoming payload bytes, ten retransmissions and approximately 10.5-second lifetimes. One connection in the next probe had the same pattern while four exchanged data. This establishes a pre-HTTP TLS/network-path stall from this monitor, not an application logout regression. DNS lookups for the monitor completed quickly. Exact router/ISP/edge attribution remains unknown. Sleep assertions were active; no matching sleep transition was found.

Remediation:

1. Fresh storage lookup/body retries share the existing two-second authority-read budget (at most three attempts). Missing records and malformed authority are not retried. Publication remains one-shot; reconciliation reads can recover transient read failures inside the existing publication bound. Late completions cannot authorize access or dispatch another read.
2. Monitor connections can try a second distinct DNS-resolved address only before a verified TLS socket is handed to HTTP. Original hostname/SNI and certificate validation remain required. DNS has a one-second bound and each connection attempt a two-second bound; the existing per-operation and whole-journey deadlines remain unchanged. No HTTP mutation is replayed. Connection-phase timings are retained without addresses or response data.
3. Confirmed alerts report the union of actual failures in the confirmation window and distinguish checks not attempted because an earlier prerequisite failed. Old pending notifications retain their exact rendering for delivery reconciliation. Alert confirmation/recovery thresholds are unchanged.
4. Denial publication/cleanup phases and fixed storage failure codes are included in causal telemetry.

Regression validation includes a real local stalled TLS endpoint followed by a trusted alternate endpoint: exactly one POST reaches HTTP, and a 503 is not retried. Certificate errors do not fail over. Storage tests cover transient lookup/body failure, exhausted retries, missing authority, ambiguous publication, and late completion after deadline. Production deployment and exact-source native evidence will be appended after completion.

Follow-up: #55 retains sustained latency and database-stall investigation; #8 retains independent detection/receipt coverage; #42 retains the measured monthly SLO. These bounded fixes and a short successful watch cannot establish 99.99% availability or identify every provider-internal cause.
