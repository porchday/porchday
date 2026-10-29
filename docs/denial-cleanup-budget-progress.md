# Preserve confirmed cleanup progress when the work budget ends

The first staging batching trial drained 400 denied sessions across 100 members
in 283 seconds. Its observed full-pass completion interval was 279 seconds,
leaving only about 21 seconds below the existing freshness threshold. This did
not establish pilot capacity.

Inspection found that the initial batch helper threw the same cleanup error when
its work-start budget expired as when SQL failed. Even if earlier member groups
had committed, a later ordinary deadline exit caused the caller to discard the
page checkpoint and continuation. The staging observations showed long gaps
between checkpoints while deletions continued; the precise contribution of this
behavior to that trial's duration has not been measured.

The revised helper distinguishes a normal stop between transactions from an
uncertain database outcome. It processes members in first-candidate order, holds
one member's identity lock at a time, and returns the contiguous input prefix
whose results are known. That prefix includes confirmed deletions, absent rows,
and ownership rechecks. The sweeper can checkpoint it and emit the existing CAS
continuation token without starting new SQL work after the deadline.

A member may have other sessions later in the input order. Deleting that whole
verified member group does not permit the checkpoint to skip intervening members.
The returned deletion count includes only the confirmed prefix; it can therefore
under-count SQL deletions performed beyond that prefix. These counters measure
acknowledged scan progress, not an audit of all physical row deletions.

Actual SQL failures and lost commit replies still throw. They leave the entire
page checkpoint unchanged, including when earlier member transactions committed.
Recovery repeats exact idempotent cleanup. No member operation is replayed, no
denial is removed, and no authentication or deadline requirement changes.

Regression coverage includes interleaved owners in reverse member-ID order,
normal deadline stops, scalar fallback, already-absent rows, prefix checkpoints
with live sessions between denials, no-progress groups after a completed group,
invalid prefix claims, rollback and unknown commit reconciliation. The subsequent staging comparison verified earlier checkpoint progress; the
combined pilot workload remains unverified.

Local validation: 49 focused tests passed against a disposable PostgreSQL 17
instance. The full API suite passed 482 tests, with 28 skipped. API typechecking,
first-party formatting, secret scanning and diff checks passed. The fresh guarded rollout and 100-member trial are recorded in
[staging evidence](evidence/denial-cleanup-prefix-staging-2026-10-29.md). Broader
capacity and production enablement remain separate gates.
