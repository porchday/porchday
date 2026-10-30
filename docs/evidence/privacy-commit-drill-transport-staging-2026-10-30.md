# Staging commit-drill transport failure and guarded recovery

This rehearsal failed automatic-recovery acceptance. Production deployments and
flags were unchanged. Staging was restored through the maintained, guarded
original-primary operator procedure; that is not evidence of automatic recovery.

## Trigger and confirmed cause

The third one-shot invocation used reviewed source
`3b32d24979b45a513403e522d2961242be086680` after all six exact-commit CI checks passed.
Read-only role admission confirmed the separate auth/jobs permissions before
creating two owned synthetic accounts. The child registered its immutable intent
and pending entry, then its scope publication failed at 02:40:24 UTC.

The temporary operator Worker's key allowlist accepted intents, receipts, batches
and probes, but omitted `commit-scopes/v1/`. Its conditional-write probe therefore
passed while the required scope route remained unsupported. Parent evidence
contains no successful scope publication or subsequent SQL phase. Independent
readback confirmed the scope and receipt absent, no SQL marker or fence, both
original test sessions present, and the child exited. The operation was not
replayed, and the pending intent was preserved.

Three continuity samples collected before the failure were healthy. They do not
cover the subsequent quarantine interval. The pre-commit denial check used a
deliberately invalid synthetic cookie; it was not a revoked-session assertion.

## Recovery evidence

- At 02:42:43 UTC, an authenticated request returned 503 and journal control was
  quarantined for `unresolved_privacy_operation`, with the one drill intent pending.
- All four staging queues were paused without purging messages or changing their
  consumers, producers or other settings. The first writer-drain observation was
  recorded at 02:43:12 UTC.
- Provider history showed the same original main branch, no restore or routing
  change, and all 40 available audit records predating the rehearsal. Two drained
  observations more than two minutes apart had identical fingerprints across all
  27 capability tables, no active writers or idle transactions, no outstanding
  cleanup, and equal SQL/R2 sequence 30,707.
- The reviewed original-primary recovery completed at 02:47:25 UTC. It performed
  691 journal reads and two writes: the evidence-linked operator receipt and the
  conditional control release. It resolved one intent, changed no SQL, found zero
  media objects requiring verification, preserved capability fingerprints, and
  verified removal of its temporary Worker and domain.
- Independent readback verified the operator receipt, active control and unchanged
  capability fingerprints. All four queues resumed with their original settings.
  Both original synthetic sessions still worked, then normal logout rejected both
  old cookies. Exact fixture cleanup verified zero remaining rows.
- Protected readiness returned 200 with no issues at 02:47:38 UTC; cleanup page and
  pass ages were two seconds. The first final control observation failed its
  active-and-empty assertion and remains recorded. A separate read-only check
  confirmed active control, no pending entries and no original operation. Final
  provider reconciliation and lease release completed at 02:48:18 UTC, sequence
  30,709. No cleanup or recovery write was replayed for that observation failure.

The observed 503-to-readiness interval is bounded by those samples; it is not an
exact outage-duration measurement. The independently monitored production service
remained healthy in the observations collected during this incident.

## Correction and remaining acceptance

The operator allowlist now accepts only the v1 commit-scope namespace alongside
its existing journal keys. Scope writes remain conditional create-only; replacement,
deletion, read-only writes, malformed paths and other versions are rejected. A
read-only scope-namespace admission probe can reject an incompatible operator
before the hosted drill registers an intent.

The full local parent/child PostgreSQL test now also passes through the actual
operator Worker and native Miniflare R2 bindings, rather than exercising only a
filesystem journal. Restricted auth/jobs credentials, scope publication, atomic
COMMIT, independent proof, SIGKILL and ordinary recovery all pass. The focused
suite totals 84 passing tests. The disposable database container was removed.

A fresh reviewed hosted invocation must enable the namespace admission probe and
retain all original timing limits. Hosted marker-only recovery, continuity through
that recovery, public auth-writer acceptance, load/cost checks and production
admission remain unverified. The failed invocation and operator recovery must not
be relabeled as a successful crash drill or as evidence of monthly 99.99% uptime.
