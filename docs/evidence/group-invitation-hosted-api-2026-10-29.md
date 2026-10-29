# Hosted staging invitation API acceptance

Operation `df776b0a-ed94-4c21-a3ff-0f239930cdda` completed at 2026-10-29T14:23:27.824Z
against staging runtime `d6fd3faca61d2d5c350d62f4e8ad5bcd50cc8f32`, version
`93259d5e-7407-484e-858b-7e72a7c85595`. The one-shot harness held the shared
release lease, checked full provider inventory against canonical state before
and after, and used two isolated synthetic accounts. No provider deployment,
production fixture or frontend asset change occurred.

The hosted API accepted initial device registration and an encrypted group
created with the candidate crypto package and a server-returned audience epoch.
The owner invited the second account by its synthetic handle. The owner roster
returned the expected invitee and inviter handles with pending status. After
the invitee accepted, the roster included its acceptance timestamp and the
invitee could read the group. Roster reads by the invitee were denied with 403
both before and after joining. Each mutation had a retained intent and result;
none was retried.

Both logout calls returned 200 and retained-cookie checks returned 401. Exact
synthetic group/account cleanup completed, followed by SQL confirmation of zero
remaining fixture account/session/member/group rows. The deployment inventory
and canonical record were unchanged and the lease was released. Process 73133
terminated successfully. Private receipts contain operation details; credentials,
keys and member identifiers are excluded from this record.

This is hosted API acceptance, not browser or physical-device acceptance. It
used real encryption for initial group creation, but does not prove that a new
member can decrypt group content, that the connection picker works in the UI,
or that already-open browsers survive the frontend release. These checks and
forward/rollback asset deployment remain outstanding under #3 and #41.
Production feature promotion remains held on #40 recovery acceptance.

## Concurrent monitor incident

External production samples between 14:14 and 14:23 UTC repeatedly failed only
`monitor_freshness`: responses included HTTP 503 and HTTP 200 that failed the
freshness predicate. Sampled login, profile/feed reads, logout/revocation and
protected readiness passed throughout this retained window. Two healthy samples
at 14:18:53/14:19:13 and 14:21:33/14:21:53 were followed by recurrence, including
14:22:13 (503), then healthy 14:22:33/14:22:53. This is not evidence of a sustained
application outage or a resolved monitoring root cause.

The independent GitHub alert path delivered incident comments
[6499111603](https://github.com/porchday/porchday/issues/52#issuecomment-6499111603)
and [6499208630](https://github.com/porchday/porchday/issues/52#issuecomment-6499208630).
Owner inbox delivery remains unverified. A direct status read returned operational
with last_checked_at 14:21:23.772Z, but does not explain the preceding failures.
Retained observations lack response bodies and exact timestamp ages; causes of
503, stale/invalid timestamps and scheduling/storage failures remain to be
investigated. Preserve the existing freshness deadline. #8 tracks this gap.
