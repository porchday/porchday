# Monitor activation integration

The maintained command now exposes explicit `activate-monitor` and
`cancel-monitor` actions, plus programmatic monitor activation and observed
activation entry points. Ordinary application activation still rejects monitor
plans. Monitor activation retains verified inactive-upload proofs, immutable
source/CI and compatibility evidence, schema fingerprints, full provider
inventory checks, fixture preflight, durable journey records, exclusive lease,
write-once deployment intents, read-only reconciliation and finalization.

Monitor-specific review additionally pins a baseline status observation and a
storage-compatibility assessment with underlying evidence. Its source identities
must match the baseline and candidate. The live gate GETs the fixed environment's
status endpoint before activation, after successful application verification,
and again before finalization. It retains bounded, sanitized aggregate history
proofs and rejects missing/malformed/stale status, changed history origin/counts,
metrics regression, response overflow and altered compatibility evidence.
The read has a five-second total deadline and a 16 KiB body cap.

Rollback authorization does not require the faulty candidate's status to be
healthy. Terminal rollback verification still checks both application journeys
and monitor history against the reviewed baseline. Canonical monitor sources
remain mandatory; existing production records must be augmented only from
verified deployed artifacts. Public assets are checked for collateral regression
but their provenance is not rewritten by monitor activation.

## Validation and limits

173 focused tests passed before the final history-failure case was added. The
final affected suites then passed 97 tests, including the composed monitor
command with a lost provider reply, actual local journals/leases, observed
activation and resumed historical completion. The provider transport, CI,
database and hosted HTTP responses were mocked in these composition tests.
Release TypeScript and whitespace checks passed.

The lost-reply case dispatches once and reconciles the resulting identity.
A separate case makes the application journey pass while monitor history fails:
finalization is refused, canonical state is not promoted, and the unresolved
lease remains. Reconciliation repeats neither login nor provider deployment.
Missing monitor-specific evidence is rejected before credentials or lease
acquisition. An actual native command invocation confirmed that the explicit
monitor action selects the monitor path and retains a fixed private error code
when configuration is missing.

No hosted upload or activation occurred. Next requirements are exact-source CI,
verified deployed monitor source provenance in canonical state, fresh staging
baseline/status and immutable manifests, then staging observed activation.
A successful immediate state read cannot establish that future scheduled ticks
will run; post-release scheduled observation progress remains separate acceptance.
The production provider-internal-error/freshness incident remains unresolved.

## Concurrent production latency evidence

At 14:37:14 UTC logout returned 200 after 7326 ms; the subsequent revocation
request reached the whole-journey ten-second deadline. At 14:41:14 and 14:41:34,
logout did not complete within the remaining journey budget (5765 and 5067 ms
respectively), and revocation could not be observed. Login, profile/feed and
readiness passed in those samples; status-monitor freshness also failed. These
are uncertain logout outcomes, not evidence that a revoked cookie was accepted.
No logout was replayed for diagnosis. #55 retains the latency investigation;
#8 retains the monitor incident. Neither is closed by these tooling changes.
