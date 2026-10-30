# Staging auth commit writer: activation and reconciled HTTP evidence

On October 30, 2026, the staging auth commit writer was enabled on version
`8bd55c44-10b8-4f3e-a98c-e040af0dcf9d`. The executable remains
`89f03970422e7869002703840b5067e5f585b11e`, with 58 migration entries.
Only `PRIVACY_COMMIT_WRITER_V1=true` was added. The recovery reader remains
enabled, and compatible rollback floor `fd35aa2e-f881-46fb-a596-e3d6eb7defb1`
was retained. Production version `048cd033-4855-4100-9fc2-d1d179fe398b`
and its configuration were unchanged.

This is **not a clean end-to-end acceptance pass**. Activation and continuity
passed; the original post-request evidence check failed, and a separate
read-only audit subsequently verified the committed operation. All failures
remain recorded. No HTTP mutation or completed deployment was replayed.

## Admission and activation

The release used tooling `9ce5e0a84e491e827dc2d5705572f22e47eb3d6e` and
runtime checkout `d7c9f5caadc667e913023a382685b2b1c05d1141`. Exact CI passed.
Local bundle provenance, dry-run upload, 38 admission checks, continuity
observer tests, schema, provider inventory, both database environments and all
six pooled runtime routes were verified. Eleven runtime modules in the
installed release watcher matched the tooling checkout.

Upload operation `4b6c1bd0-e0d0-42df-8980-52168cb6c8d1` completed. Activation
`84e93415-532d-42cf-a658-1eabea5ee3bf` completed at 03:09:58.931 UTC.
The continuity window was 03:09:38.436–03:09:58.922 UTC: 11 samples,
zero failures, two post-command samples and maximum start gap 2,003 ms.
Maximum request durations were 731 ms for the allowed profile, 1,011 ms for
feed, 645 ms for the denied profile and 640 ms for protected readiness.
These are bounded observations, not a continuous or global uptime guarantee.
The 5-second continuity and 10-second user-journey budgets were unchanged.

## Actual HTTP writer and evidence failure

Ordinary logout deliberately uses independent session-denial publication and
bypasses the global privacy commit writer. The test therefore used a fresh
owned synthetic session with `POST /api/auth/revoke-sessions`.
It returned HTTP 200 in 3,344 ms at 03:10:06.677 UTC. Its cookie was rejected
afterward, while another synthetic account remained available.

The original 10-second evidence collection failed with
`R2_OPERATOR_REQUEST_FAILED`. A subsequent read-only audit using the REST
adapter failed with `R2_STRONG_ETAG_REQUIRED`. The first failure's exact
transport cause was not established; do not assume it shares the second cause.

A separate content-only audit completed at 03:11:33.141 UTC. It read immutable
intent/scope/batches and authoritative control without relying on REST ETags.
Local content hashes were explicitly not provider ETags and could not authorize
conditional writes. The audit used a 60-second overall control-plane budget
with 10-second GET limits; this did not change user-journey budgets or convert
the original failed acceptance into a pass.

It verified exactly one new SQL marker after the fresh preflight cursor,
with its intent timestamp inside the original request window: operation
`555d85ff-ed5b-4d69-8b53-66832ff5e133`, sequence `30713`. The immutable scope
hash, unique SQL fence, canonical marker and ordinary receipt matched. The
operation was retired, the owned session was absent, the account remained,
and the journal was active in its unchanged generation. No receipt, marker,
control value or SQL mutation was synthesized or replayed by the audit.

## Preserved failures and cleanup

- An earlier preparation copy retained a prior operation's directory. Its
  existing-operation guard refused execution before hosted writes. Corrected
  inputs were prepared in a fresh scope.
- A read-only preflight timed out; a fresh read-only check passed. No mutation
  was retried.
- The first acceptance launch failed while importing TypeScript, before any
  fixture or activation event. An explicitly reconciled launch used the
  installed TypeScript loader with unchanged frozen acceptance inputs.
- The first cleanup admission failed before its mutation intent. Its cause was
  not retained precisely enough to diagnose. Separate read-only admission
  passed before a new cleanup attempt; no logout or deletion was replayed.

Cleanup completed at 03:12:40.343 UTC. Both revoked cookies remained denied;
the surviving account logged out normally, then its cookie was denied. Exact
owned fixture rows were deleted and verified absent, private cookie/password
files removed, provider inventory reconciled and the owned lease released.
The reconciliation result deliberately retains `passed:false` for the original
acceptance. Private evidence is retained under
`artifacts/private/journal-commit-writer-v3-staging-20261030/`.

## Remaining gates

Require a clean normal HTTP writer acceptance with a correctly scoped evidence
reader, an actual writer-enabled rollback rehearsal to the retained reader
floor, credential-change and other relevant auth-path coverage, concurrency
and load/cost validation before production admission. This test does not prove
Cloudflare isolate-loss recovery or resolve generic pre-SQL intent-publication
failures. Scheduled feature releases, owner inbox/device checks, Mac power and
network redundancy, and measured monthly availability remain outstanding.
Keep #1 and #42 open with verification pending; 99.99% is not established.

The follow-up `scripts/r2-journal-audit-store.ts` makes the content-only reader
reusable for operator evidence. It rejects every write, never treats its local
content hash as a provider ETag, and bounds GET duration and streamed body size.
Tests exercise canonical marker/receipt proofs through responses without ETags,
altered batch rejection, cancellation and invalid responses. This reader is
operator tooling, not a change to deployed runtime or journal recovery policy.
Its clean hosted acceptance remains a separate gate.

The first fresh standalone HTTP attempt stopped at this reader's admission
check with `JOURNAL_STORE_READ_FAILED`, before creating any fixture or sending
an auth mutation. Its lease was reconciled and released. A separate live
read-only check had verified the existing operation with ten GETs in 3,065 ms;
another instrumented check after a provider snapshot also passed. These reads
do not establish the intermittent failure's root cause, and the failed attempt
remains failed.

The reader now permits at most three attempts for transient GET transport/body
failures and selected retryable HTTP statuses, with 250/500 ms backoff. Each
attempt keeps its 10-second deadline inside the caller's overall deadline.
Malformed content, oversized responses, authorization failures, cancellation
and every write remain refusals. A sanitized attempt callback records failures
and retries; inability to retain that evidence stops the read. Fifty-four
focused tests pass, including capped retries, no retry after authorization
rejection, durable-evidence failure and canonical-proof validation. This change
does not retry HTTP mutations or change deployed request budgets. A clean
hosted HTTP test using the updated reader is still required.

A later [fresh native-bridge session-revocation test](privacy-commit-http-native-staging-2026-10-30.md)
passed. It is separate evidence and does not change this run's failed acceptance
or establish REST transport reliability. Broader auth paths and writer-enabled
rollback are still outstanding.
