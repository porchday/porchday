# Read-only evidence for overlapping authentication writes

`scripts/auth-commit-cohort-proof.ts` provides `proveAuthCommitCohort` for a
controlled staging rehearsal with two to four distinct owned accounts. It
audits an already completed set of requests; it cannot dispatch, retry or
recover an auth mutation. The caller must independently verify the staging
database/bucket and deployment scope, retain the original HTTP evidence, and
own its exact synthetic fixtures. This helper is not a production rollout gate
by itself.

Supply the pre-request marker sequence and journal generation, a read-only
journal getter, a database query connection, a live scope assertion and the
original request windows. Each window must record HTTP 200, subsequent cookie
denial, distinct member/session IDs and a duration within ten seconds. All
client windows must overlap. Overlapping client windows do not prove that SQL
transactions execute simultaneously; the protocol may serialize them.

The auditor requires exactly the expected number of fresh, unique SQL fences
and canonical markers. It checks original intent/scope hashes and generation,
finds a one-to-one assignment of intent timestamps to the request windows, and
proves every marker and ordinary receipt on the active canonical journal. All
pending intents must be retired. It then verifies the owned sessions are absent,
the accounts remain present, SQL is not quarantined, and journal control has
not changed during the proof. Missing or extra evidence is a failure, not
permission to retry requests.

Commit scopes intentionally contain no member identity. The result therefore
always reports `perRequestIdentityProved: false`. Time-based window assignments
are labeled unique or ambiguous; neither establishes a marker-to-member link.
Report the result as aggregate evidence for the controlled cohort, with this
limitation. Do not fabricate an individual mapping from array order or matching
counts.

The SQL reads select at most five fences (one beyond the permitted cohort) and
only the supplied session/account IDs. Journal access exposes no write path.
The helper enforces a 60-second total deadline, ten seconds per read, 1,024
journal reads, bounded object sizes and the existing canonical-proof limits.
Caller cancellation also stops further evidence work. Errors have a fixed code
and contain no returned provider, database or member payload. A moving journal
or unknown result requires read-only reconciliation with the original evidence;
never repeat an auth mutation to obtain a cleaner result.

Local verification covers canonical receipts, corrupt/missing/orphan evidence,
duplicate and surplus fences, a window-union case that lacks a valid one-to-one
assignment, unsafe request inputs, SQL/session/account disagreement, control
drift, cancellation and stalled body/database reads. The real auth-route tests
exercise the same auditor against PostgreSQL with two and four overlapping
requests and an unaffected account. Their R2 store is simulated. Hosted
concurrency and native-provider behavior remain separate acceptance requirements.

The subsequent [hosted two-request rollback rehearsal](evidence/privacy-commit-cohort-rollback-staging-2026-10-30.md)
passed with native journal proof. It covers that controlled cohort and preserves
the identity and SQL-simultaneity limitations above.

## One-shot staging request collection

`dispatchAuthCommitCohort` in `scripts/auth-commit-cohort-dispatch.ts` collects
the HTTP evidence for this auditor. Its caller must first admit the exact
staging deployment and lease, create two to four authorized synthetic fixtures,
and capture the SQL baseline and generation. It only targets
`https://staging.porchday.com`; it does not create fixtures, activate deployments,
read SQL, or declare canonical proof successful.

Use a fresh private directory. Exclusive, fsynced batch and individual intent
files must all exist before dispatch. Requests overlap without a retry path;
each POST and subsequent denial GET has a ten-second observation deadline.
All dispatched observations settle before the helper returns or rejects. A
timeout or cancellation does not prove the remote mutation failed: preserve
that directory and reconcile read-only. The exclusive batch intent prevents
reusing the same directory even after a partial failure. Never create a new
directory merely to repeat an uncertain operation.

Evidence files exclude cookies, response bodies and provider errors. Individual
results survive other requests failing. Success requires every POST to return
200 within budget, every owned cookie to return 401, common overlap of the
recorded client windows, and an unchanged caller scope. The returned windows
still require independent canonical proof after rollback. Exact fixture cleanup
and deployment reconciliation remain the caller's responsibility on every path.
