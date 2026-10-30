# Staging reader rollback — October 30, 2026

The API controller automatically restored the compatible reader baseline after
an isolated browser fault. The complete rehearsal **failed continuity acceptance**:
one protected readiness request failed at the transport stage during rollback.
Do not count this as a zero-downtime pass or replay the operation.

## Scope and implementation

Tooling `6af3459dc99d368f87fac1c1c394a48ea5cf429d` adds a staging-only API
recovery drill. It requires identical baseline/candidate frontend manifests and
rejects frontend deployments, production, and application asset changes. The
normal controller verifies candidate API journeys before an exception is injected
only into the observer's fresh browser context. Served application assets are
unchanged. The normal rollback controller must restore and verify the explicitly
compatible baseline; an unknown browser result cannot qualify as a successful
drill.

Local validation passed 63 tests, including real Chromium
with synthetic deployment transport, both TypeScript configurations, formatting,
secret and diff checks. All six exact-source CI checks passed: Verify
40986935224/40986929177, browser 40986935105/40986929202, and secret scan
40986935088/40986929194.

## Hosted evidence

- Activation operation: `185deb10-a5ed-4a78-94b6-91e38db58b84`.
- Candidate: `4d604da8-e033-4966-826c-ef22bee1ac4b`.
- Baseline and retained reader floor: `fd35aa2e-f881-46fb-a596-e3d6eb7defb1`.
- Runtime for both versions: `89f03970422e7869002703840b5067e5f585b11e`.
- Candidate deployment: `beb65368-e183-4436-b066-ae95b85ee7bf`.
- Rollback deployment: `6e6029f9-6af4-4322-9e4a-a3742af3ba9d`.

The durable browser report at 01:45:52.294 UTC observed the injected exception:
one fresh-context page error, no old-context page or module MIME errors, matching
new document, rendered login, and the retained lazy module fetched successfully.
The controller recorded terminal rollback at 01:46:08.944 UTC, 16.650 seconds
after that report. This is report-to-terminal time, not outage duration.

Seventeen continuity samples ran from 01:45:40.038 through 01:46:12.431 UTC,
including two sample starts after command termination. All authorized profile,
empty-feed and revoked-cookie checks passed. At 01:45:58.050, while the journal
recorded rollback intent, protected readiness failed before a response was
available, after 8 ms. Its next sample and all later samples passed. The preserved
diagnostic identifies transport failure only; it does not establish a Worker,
Cloudflare, local-network or connection-reuse root cause. No retry erased this
failure. The wrapper correctly rejected overall acceptance.

Canonical state and provider inventory confirm the original baseline, reader
floor, schema count 58, unchanged frontend and isolated queue settings. Recovery
remains enabled; the privacy commit writer remains absent. Production was not
deployed or reconfigured.

## Reconciliation and alerting

A separate, recorded cleanup checked provider inventory before writes, verified
the revoked cookie remained rejected, logged out the second synthetic session,
and removed exactly the two owned accounts. SQL checks confirmed zero remaining
fixture rows. Cookie and retained-fixture files were removed, provider inventory
was rechecked, and the deployment lease was released. The original failed run and
all continuity samples remain preserved.

The installed Mac watcher at `a589e7a5fbcb7b7010da15e5ddcea0757e3bede4`
persisted delivery of the actual command-failure event. Read-only verification
found exactly one matching [GitHub bot alert](https://github.com/porchday/porchday/issues/3#issuecomment-6512917025)
and two subsequent clean polls with zero pending alerts or errors. This proves
GitHub delivery, not owner inbox receipt.

## Remaining acceptance

The follow-up continuity probe records a fixed network category for recognized
socket, reset, refusal, DNS, connection-timeout and certificate errors. Unknown
errors stay unknown. It reads only own data properties and one cause level, never
messages, URLs, addresses or arbitrary error codes. Deadline and body-validation
failures remain distinct, failed observations remain failures, and no retries or
deadline increases were added. Sixty-two continuity/observer tests passed,
including privacy, getter, nested-cause, body-socket and deadline cases. This
diagnostic improvement cannot retrospectively identify the original failure.

Investigate the isolated transport failure with bounded, non-sensitive diagnostics
before claiming reliable release continuity. A future rehearsal needs a fresh
operation, reviewed current-state pins, unchanged deadlines, all failed samples
retained, verified rollback, complete observation and exact fixture cleanup.
Hosted marker-only crash recovery, writer activation, workload/cost acceptance,
production rollout and daily scheduled-release adoption remain unverified.
Monthly 99.99% availability requires the full observation period; this drill does
not establish that SLO or Mac power/network redundancy.
