# Photos rollout: deployment and test-process audit

Scope: the owner-requested Photos/calendar rollout in issue #102 and the staging
activation failure recovered in PR #105. Production application changes are not
part of this tooling audit. The verified application release remains in place.

## Findings and changes

| Finding | Evidence from the rollout | Correction |
| --- | --- | --- |
| Activation responses were discarded on failure. | The maintained client cancelled non-2xx bodies and threw a generic uncertainty error. The original staging POST was later identified as HTTP 500 through its exact provider audit event. | The maintained client now retains an exclusive, fsynced intent before POST and a private bounded result: HTTP status, Ray ID, success/error codes and redacted error messages. No request credentials or full provider payload is stored. Transport errors remain unknown and are not retried. |
| A private fetch wrapper was needed to retain later provider responses. | Subsequent rollout harnesses added ad hoc response capture. | The maintained activation CLI wires receipt persistence directly into its provider client, including rollback writes. Callers no longer need that wrapper. Duplicate intent files prevent redispatch; receipt/scope failures before dispatch stop the write. |
| Audit reads enforced their size limit too late. | Reconciliation used `response.text()` before checking length. | Audit and deployment clients share a streaming byte-bounded JSON reader that cancels oversized streams. |
| Cancellation support had diverged from the installed watcher. | The installed watcher accepted only pre-intent cancellation, while PR #105 introduced an audited cancellation receipt. Its underlying lease implementation also contained later changes than the reconciliation branch. | Prepare a narrow watcher update from the exact installed source, preserving its lease implementation. Validate receipt scope and the retained journal; keep explicit failure notifications actionable. Installation must follow exact-source CI and live readback. |
| Migration composition can overwrite environment-specific functions. | Initial migration 059 replaced the staging 057 restore-reader behavior; composition CI caught it before hosted writes. | Already corrected in PR #104 with guarded transformations of the installed function and tests against both environments. Keep this as a required composition gate, not a reason to skip staging-only tests. |
| Different tests prove different things. | Old-tab/fresh-tab asset checks were separate from authenticated API continuity and the later signed-in calendar test. Photo/caption interaction was tested locally with synthetic transport. | Preserve those distinctions in release acceptance. A green health response or asset test alone is not feature acceptance, physical-device acceptance, installed-service-worker acceptance, or a monthly availability result. |

The local focused gate is `scripts/check-release-tooling.sh`. It stops on the
first failed step; a later passing typecheck cannot mask a failed test command.
Hosted exact-commit CI remains mandatory.

## Verification and operating rules

The regression tests cover a retained HTTP 500, malformed/oversized bodies,
transport ambiguity, credential redaction, failure before intent persistence,
duplicate-dispatch prevention, and mismatched/tampered receipt scope. Existing
recovery and browser-gate tests must continue to pass. Watch tests cover valid
archived evidence, tampering, and retention of explicit failures.

Keep deployment intent, provider receipt, journal, continuity samples, browser
acceptance and terminal provider identity separate. A response receipt is diagnostic
evidence, not permission to retry. HTTP 500 alone does not establish non-commit;
reconciliation still requires matching failed provider audit evidence and unchanged
original deployment history. Never fabricate a successful terminal state or delete
a failed operation to clear a lock.

Provider error details stay in owner-only files, not command errors, public issues,
or telemetry. Read-only audit requests must consume a complete bounded result set;
missing or conflicting records stop reconciliation. Apply the same rules to rollback
writes. Do not weaken exact-source CI, shared leases, schema/reader floors, retained
assets, authenticated continuity, or browser gates to reduce release duration.

A release report must identify application and tooling revisions, environment
compositions, migrations, actual provider versions, covered client journeys,
retained failures, cleanup and limitations. Mark each required acceptance scope
explicitly; do not infer a broad claim from a narrow passing test.

## Remaining scope

Issue #3 remains open for its broader scheduled-adoption, hosted fault-injection,
installed/native client, and monitoring coverage requirements. This audit and the
manual feature rollout do not close those criteria or establish a monthly SLO.
