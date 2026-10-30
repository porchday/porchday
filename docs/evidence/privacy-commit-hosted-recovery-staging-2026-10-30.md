# Hosted marker-only recovery acceptance — staging

The fourth one-shot rehearsal passed at 02:58:39 UTC on October 30, 2026.
The deployed staging reader recovered a committed, receipt-less operation after
the original 120-second stale interval. All 56 sampled continuity checks passed;
exact fixture cleanup, temporary operator teardown and lease release passed.
This establishes the bounded rehearsal below, not monthly 99.99% availability.

## Reviewed state and fault placement

The controller used clean source `ee76b05c9cac77a9ae0b7d2b49c0db66239e6278`
after all six exact-commit CI checks passed. Fresh provider, schema, pooling,
role-permission and independent production-monitor checks passed. Staging remained
on version `fd35aa2e-f881-46fb-a596-e3d6eb7defb1`, runtime source
`89f03970422e7869002703840b5067e5f585b11e`, schema 58 and the compatible reader
floor. Recovery was enabled; the public commit-writer flag remained absent.
Production deployments and flags were unchanged.

The temporary native R2 bridge passed authentication, conditional-write and
commit-scope namespace admission before fixtures were created. The drill used
only two newly owned synthetic accounts. The child received restricted auth/jobs
connections through private IPC; the parent retained the R2 capability and used
its independently constrained journal adapter.

At 02:56:21.594 UTC the child registered the intent. It then published its immutable
scope and deleted exactly the owned primary session in the same SQL transaction
as the unique commit marker/fence. After COMMIT, the parent independently verified
the owned mutation, scope digest, marker, fence, generation, pending entry and
absence of a receipt. It persisted kill intent before SIGKILL and confirmed the
child's SIGKILL exit at 02:56:25.074 UTC. Post-kill readback confirmed the exact
pending entry and no receipt.

## Ordinary hosted recovery

Only ordinary deployed reader/cron code could perform recovery: the invocation
contained no local recovery call, clock adjustment, intent deletion or control
rewrite. It did not replay the SQL mutation or user action.

The last poll still observing the pending entry was at 02:58:22.666 UTC. The first
poll observing both an ordinary receipt and retirement was at 02:58:27.957 UTC,
126.363 seconds after intent registration. This polling interval bounds observation
of completion; it is not the request's recovery latency.

At 02:58:30.770 UTC the independent read-only verifier proved the exact marker and
receipt on canonical ancestry at sequence **30,710**, after the original scope
baseline. It verified the matching unique SQL fence, owned session absence,
pending retirement, unchanged generation and no quarantine. It did not itself
perform recovery. The generation was unchanged throughout.

## Continuity and cleanup

The retained sampling window ran from 02:56:20.143 through 02:58:34.230 UTC:
56 samples, zero failed samples, no watcher failure and two complete post-recovery
samples. The maximum sample-start gap was 3.523 seconds. Requests retained the
five-second continuity deadline; login/logout journeys retained ten seconds.

| Check | Observed p95 | Observed maximum |
| --- | ---: | ---: |
| Surviving account profile | 545 ms | 1,475 ms |
| Surviving account feed | 655 ms | 1,510 ms |
| Denied profile | 598 ms | 1,386 ms |
| Protected readiness | 588 ms | 1,424 ms |

Before commit, the primary session was independently verified as authorized and
the continuity denial check used an invalid synthetic cookie. After confirmed
commit/kill, the denial check used the exact deleted session. The surviving
account's profile and empty feed, cache controls and protected readiness remained
healthy in every retained sample. These are sampled observations, not proof of
continuous or global zero downtime.

The primary session remained denied. The surviving account logged out normally
and its old cookie was rejected. Cleanup verified zero remaining owned fixture
rows and removed temporary cookie/password material. The native bridge verified
removal of its exact temporary Worker and domain. Final provider inventory matched
the admitted baseline, and the deployment lease was released. No production
mutation or public commit-writer enablement occurred.

## Limits and next gates

This is local child-process loss against hosted SQL/R2, followed by recovery by the
actual deployed Worker. It is not Cloudflare isolate termination or an end-to-end
HTTP auth-writer crash. The scope namespace fix and this pass do not erase the
three earlier failed attempts or the third attempt's staging quarantine and
operator recovery; those remain separately recorded.

The public auth writer still needs reviewed activation, normal hosted auth-path
acceptance, compatible rollback under the final configuration, concurrency and
recovery latency/cost checks, and production admission. Daily scheduled feature
release acceptance, owner/device/inbox checks, infrastructure redundancy and a
sufficient monthly observation period remain separate. October's sampled error
budget is already exceeded and coverage is incomplete; this rehearsal does not
establish the 99.99% monthly objective.
