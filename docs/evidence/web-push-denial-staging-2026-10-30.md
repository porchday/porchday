# Hosted web push denial rehearsal

Completed October 30, 2026 at 00:24:53 UTC. Tracks #42. This staging rehearsal
provides hosted evidence for the web push authority check while the SQL session
is retained. It does not establish native-device behavior or monthly availability.

The deployed runtime was `3c50e2ebe7a6dcf29177867be7dca373e110d4c0`, staging
version `0d333719-a457-40a5-94a2-8ee4a2371ded`. Operator source was pinned to
`6840e177d848c249ece7cab39f70a40d7f6b4204`, release tooling to
`4d4ed89e7b19bda88a0e469065afebf629ac098c`; all six applicable CI checks passed
for each pinned checkout. Private acceptance-policy checks passed 46 cases,
and read-only metrics and database-pooling preflights passed before execution.

## Observed behavior

Two freshly allocated synthetic accounts and a fresh Chrome profile were used.
The browser obtained a real FCM subscription using the deployed public VAPID
key and registered it through the authenticated application API. Exact owned
synthetic SQL notifications exercised the normal notification trigger, outbox,
scheduled worker, provider and deployed service worker. This was not a direct
provider send or a synthetic browser push event; it did not exercise creation
of notifications through the social application UI.

1. The positive control produced a `sent` outbox entry and an actual browser
   notification with the expected generic preview. The notification was cleared
   before the negative check.
2. Only the recipient fixture's identity advisory lock was held. One logout
   returned 503 in 5.932 seconds; independent denial was confirmed while its SQL
   session remained present. The SDK returned anonymous, the member endpoint
   returned 401, and the unrelated account remained usable.
3. A second exact owned notification completed after one attempt with outbox
   outcome `failed`, while the SQL session and lock were still present. The
   immutable denial was confirmed again. No browser notification was observed.
4. A fixed aggregate query over the negative observation window returned one
   observed `web_push_denied` point, with weighted event and quantity values of
   one. The deployed source emits this code only after confirmed authority
   denial skips sending and the SQL finish call returns.

The counter is identifier-free, best effort aggregate evidence, not a durable
receipt for an individual job or device. The failed outbox or absent browser
notification alone would not have passed this rehearsal. The conclusion rests
on the combined positive control, owned outbox observation, retained SQL row,
canonical denial, deployed code and positive aggregate observation.

## Cleanup and recovery

The fixture lock was released normally after 57.048 seconds, below its 95-second
local limit and 105-second server fallback. Global cleanup was never paused.
Normal cleanup was subsequently observed removing the denied SQL session.

Browser unsubscribe and profile removal were verified. Exact synthetic account
cleanup left zero rows and retained immutable denials. Four recovery journeys
were healthy (maximum 2.232 seconds), with journal sequence at or beyond the
cleanup barrier and fresh completed passes for all three denial ranges. Final
provider inventory and canonical deployment were unchanged, and the deployment
lease was released. The one-shot operation is terminal and must not be replayed.

Production stayed at `048cd033-4855-4100-9fc2-d1d179fe398b`, with denial writers
and cleanup disabled. No deployment, routing, queue limit, schema, deadline,
endpoint-validation or telemetry-privacy setting changed during this rehearsal.

Native delivery/revocation on an owned physical device, hosted password ordering,
storage/process interruption, scheduled-release acceptance and actual monthly
availability remain separate open requirements. This single web push rehearsal
does not close the broader production admission audit.
