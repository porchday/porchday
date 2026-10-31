# Feature proposals in the feed

Only the main signed-in feed loads proposal cards. Group feeds, walls and post
pages do not. Cards show a short plain-text preview, score, current vote and a
full-proposal link. The board follows that link across its existing pagination.
Proposal IDs and post IDs occupy separate key namespaces. Pages are deduplicated
and merged by creation time with deterministic ties; ordinary post ties retain
server order. Post payloads, decryption and audience rules are unchanged.

The existing board endpoint accepts `surface=feed`. It requires the current
builder disclosure and existing allowlist, returns only open proposals, and
marks its gated response explicitly. Its cursor still advances over closed rows,
so empty filtered pages do not lose older open plans. Older APIs lack the marker;
new clients hide proposals in that case. Vote writes use the existing endpoint,
SQL lock and dispatch rules. No schema migration or approval-policy change occurs.

Proposal loading is independent of post loading. There is one initial bounded
proposal-page request, then one additional page on Load more. Visible eligible
feeds revalidate their loaded pages every 15 seconds and on focus/visibility/online.
Denied access stops interval requests; focus or explicit refresh may recheck.
No content is persisted locally. Requests are serialized and late responses after
unmount or switching away from the main feed are ignored. Successful votes read
back server state; failed or ambiguous writes are never automatically retried.
Refresh failure clears unverified cards and presents a retry action. Queued
proposals disappear after refresh, and the server rejects stale voting attempts.

## Validation and release

Local validation includes real-session/restricted-role PostgreSQL tests for
eligibility, disclosure, pagination over closed rows, access revocation, shared
scores, concurrent exactly-once dispatch and locked votes. Unit tests cover merge
ordering, ID collisions, previews and control state. The maintained browser script
checks Chromium and WebKit at 320/390/1280px: keyboard voting, readback, duplicate
pages, focus refresh, queued votes, failures, pause, revoked access and old API
compatibility. It runs in a dedicated CI workflow. The existing post-detail browser
regression also passes. Browser checks use synthetic local fixtures, not members.

The baseline web build at faead0f using the same dependencies produces a 964.47 KB
main JS file (164.31 KB gzip). The candidate is approximately 969 KB (166 KB gzip),
about 1.6 KB additional compressed startup JavaScript. Request counts are bounded
by loaded proposal pages and do not add round trips to the post-loading await
chain. These measurements do not establish hosted/mobile latency or database load.

Rollout requires release admission under the reliability policy in issue #42.
Deploy the compatible API through staging before enabling the web assets; preserve
current runtime flags, provider configuration and retained assets through the
maintained release controller. Verify eligible and ineligible sessions, voting,
full links, pagination and feed loading on staging, then repeat production checks.
No production deployment or hosted acceptance is claimed by local tests.

Rollback uses the normal builder-chat revert command and controlled deployment.
The previous frontend remains compatible with this API. Rolling the API back first
causes the new feed to hide proposal cards because the gated-response marker is
absent. Votes and approval state remain in their existing tables; do not remove
votes or requeue dispatched jobs. Track remaining acceptance in issue #44.
