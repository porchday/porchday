# Health-alert forensics — November 15

Status: API deployed to staging and production; independent monitor installed and its post-installation window passed. [PR #240](https://github.com/porchday/porchday/pull/240) merged as `e27ff304c566b79543d7c0f6a665e8a20d33df17`.

Issue #52 contains distinct confirmed failure/recovery transitions, not duplicate delivery of the same event. Three failure classes are visible after the November 12 logout release:

* November 13: correlated journal safety-status database reads exceeded the guard deadline. The database/pool/provider-internal cause is not established by those traces. This is not evidence that the revocation operation itself was slow.
* November 14 around 19:41–20:05 UTC: R2 GET errors and failed logout publication/reconciliation. Global journal reads already retried, while independent session-denial and cleanup-health reads were single-shot. A failed logout acknowledgement does not establish revocation of that request's cookie.
* November 15 at 08:04 and 16:06 UTC: headers deadlines also affected independent status/readiness requests; dependent profile/logout/revocation checks were often skipped. Mac kernel evidence confirms both windows: at 08:04 UTC one connection stalled and then five stalled in the next probe; at 16:06 UTC five stalled and then one stalled in the next probe. TCP established in 4–9 ms, followed by zero incoming payload bytes, 10–12 retransmissions and approximately 10.5-second lifetimes. Other connections in the partially failed probes exchanged data normally. This establishes a pre-HTTP TLS/network-path stall from this monitor, not an application logout regression. DNS lookups for the monitor completed quickly. Exact router/ISP/edge attribution remains unknown. Sleep assertions were active; no matching sleep transition was found.

Remediation:

1. Fresh storage lookup/body retries share the existing two-second authority-read budget (at most three attempts). Missing records are not retried. Production validates canonical authority after the raw read retries; malformed bytes remain failures. Staging retains its separate partition adapter and strict range validation. Publication remains one-shot; reconciliation reads can recover transient read failures inside the existing publication bound. After the read helper’s deadline, late completions cannot produce an authorization result or dispatch another read.
2. Monitor connections can try a second distinct DNS-resolved address only before a verified TLS socket is handed to HTTP. Original hostname/SNI and certificate validation remain required. DNS has a one-second bound and each connection attempt a two-second bound; the existing per-operation and whole-journey deadlines remain unchanged. No HTTP mutation is replayed. Connection-phase timings are retained without addresses or response data.
3. Confirmed alerts report the union of actual failures in the confirmation window and distinguish checks not attempted because an earlier prerequisite failed. Old pending notifications retain their exact rendering for delivery reconciliation. Alert confirmation/recovery thresholds are unchanged.
4. Denial publication/cleanup phases and fixed storage failure codes are included in causal telemetry.

Regression validation includes a real local stalled TLS endpoint followed by a trusted alternate endpoint: exactly one POST reaches HTTP, and a 503 is not retried. Certificate errors do not fail over. Storage tests cover transient lookup/body failure, exhausted retries, missing authority, ambiguous publication, and late completion after deadline. Full CI includes database-backed checks; exact-source native and deployment evidence follows below.

Follow-up: #55 retains sustained latency and database-stall investigation; #8 retains independent detection/receipt coverage; #42 retains the measured monthly SLO. These bounded fixes and a short successful watch cannot establish 99.99% availability or identify every provider-internal cause.

## Release evidence

No schema, frontend, provider binding, alert confirmation threshold, or recovery threshold changed. The two API candidates apply the patch to each environment’s previously deployed source; staging retains its existing partitioned cleanup and also receives bounded reads on partition-health checks. The maintained activation CLI enforced native parity.

| Target | Reviewed source | Full CI | iOS simulator | macOS |
| --- | --- | --- | --- | --- |
| Production API | `bf467806920104589f39828e2c4c6ecede1b61fe` | [passed](https://github.com/porchday/porchday/actions/runs/43756535284) | [passed](https://github.com/porchday/porchday/actions/runs/43756535230) | [passed](https://github.com/porchday/porchday/actions/runs/43756535232) |
| Staging API | `ecd49ec4268a5f98ce8cb3d266c7a7f5a1549b0e` | [passed](https://github.com/porchday/porchday/actions/runs/43756778390) | [passed](https://github.com/porchday/porchday/actions/runs/43756778419) | [passed](https://github.com/porchday/porchday/actions/runs/43756778525) |
| Independent monitor | `e1a03970e3b8ecbf32ac0ca600af958610aea4cc` | [passed](https://github.com/porchday/porchday/actions/runs/43756431385) | [passed](https://github.com/porchday/porchday/actions/runs/43756431362) | [passed](https://github.com/porchday/porchday/actions/runs/43756431360) |

Staging API version `b24f7f05-b575-400a-ad88-dfab45e1d20c` activated successfully: 15 continuity samples, 0 failures, 2 post-command samples. Allowed-session access, logout and revoked-cookie denial passed. Owned synthetic fixture rows were removed; denial records remain.

Production API version `727bd4af-393f-4485-a870-117d2f621d23` activated successfully: 13 continuity samples, 0 failures, 2 post-command samples. Allowed-session access, logout and revoked-cookie denial passed. Owned synthetic fixture rows were removed; denial records remain.

The monitor was replaced at 20:30 UTC with incident history and the existing responder reference preserved. Its bundled transport passed a live anonymous-session check. No signed native binary was distributed; physical-device timing remains pending.

Post-installation acceptance: 8 consecutive healthy probes across 140.018 seconds; zero failed probes, all nine checks exercised, 72 connection diagnostics recorded. Monitor replacement start-to-start gap was 20.396 seconds against the normal 20-second cadence. Bundle hash and running process matched the installed source; the responder reference remained present.

In this small window, logout median/max were 884/934 ms; revocation median/max were 234/290 ms. These are observed samples, not p99.99 estimates.
