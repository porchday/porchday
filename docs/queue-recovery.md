# Queue recovery and reconciliation

The application has one jobs queue and one dead-letter queue per environment. `infra/resources.json` records their exact names and IDs. Minute `expiry` messages reconcile durable deletion, identity, email and notification outboxes. `media_backup_start` creates or resumes a daily snapshot; `media_backup` carries one immutable snapshot UUID. The SQL/R2 work is idempotent. A queue message is a wake-up signal, not the only record that work exists.

After correcting the underlying error, first allow the ordinary scheduled consumer to run. Compare protected operations health and the relevant durable outbox/snapshot state with the earlier incident. A fresh heartbeat alone does not prove every backlog cleared. Do not move creation times, mark work complete, release restore quarantine, delete backup evidence or purge a queue to make an alert disappear. A privacy-journal integrity failure needs the restore procedure, not message replay.

## Bounded manual replay

Use a reviewed operator checkout and the private wrapper. The commands below were validated against installed Wrangler **4.152.0** help and the official API shape on October 25, 2026; they were **not executed against a live DLQ**. Select one environment explicitly. Example for staging:

```sh
python3 scripts/with-secrets.py npx wrangler queues info porchday-staging-jobs
python3 scripts/with-secrets.py npx wrangler queues info porchday-staging-jobs-dead-letter
```

Inspect queue/consumer configuration without printing message bodies or leases. Stop if IDs/names differ from the manifest, the destination consumer is unhealthy, or another operator is already replaying. Configure a pull consumer **only on the DLQ**, which normally has none:

```sh
python3 scripts/with-secrets.py npx wrangler queues consumer http add porchday-staging-jobs-dead-letter --batch-size 1 --message-retries 100 --visibility-timeout-secs 60
python3 scripts/with-secrets.py npx tsx scripts/queue-replay.ts staging --replay --limit 1
```

After one job succeeds, inspect protected health and durable work state. Increase a subsequent explicit limit to at most ten only if appropriate. Do not run an unattended replay loop. The helper verifies both queue identities and consumer types, leases one message at a time, decodes only the existing JSON job contracts, republishes to the original jobs queue, and acknowledges only after provider-accepted publication. It prints aggregate progress, never message data, UUIDs, leases or credentials. A timeout or crash after publication can produce a duplicate; it cannot guarantee exactly-once delivery. An unconfirmed acknowledgement is an error, not reported success.

Unknown/corrupt/V8 messages stop the helper without acknowledgement. Preserve them for private investigation. Pulling changes delivery attempts; repeated failed pulls can exhaust retries even though no acknowledgement occurred. The elevated temporary retry allowance is not a retention extension. Do not dump sensitive messages into a ticket, terminal log or repository. Remove the temporary consumer when reconciliation is finished:

```sh
python3 scripts/with-secrets.py npx wrangler queues consumer http remove porchday-staging-jobs-dead-letter
python3 scripts/with-secrets.py npx wrangler queues info porchday-staging-jobs-dead-letter
```

Production uses the matching `porchday-production-*` names and `production` argument. Never remove the normal jobs Worker consumer. Record environment, incident window, replay/acknowledgement counts, remaining backlog, and final consumer removal. Leave uncertain work pending; investigate source delivery/backoff before another attempt.

Cloudflare documents that a DLQ needs its own consumer, and unconsumed DLQ messages expire after four days. Durable outboxes and snapshot inventory remain the recovery authority if a queue wake-up expires. [Dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)

The helper uses the documented `/messages/pull`, `/messages`, and `/messages/ack` endpoints. JSON pull bodies are base64 encoded; publishing uses `content_type: "json"`. The scoped operator token needs queue read/write permissions; no credential is installed in the independent monitor. [Pull and acknowledgement API](https://developers.cloudflare.com/queues/configuration/pull-consumers/), [publish API](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/push/), [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/queues/)

Unit tests cover contract rejection, bounded explicit invocation, empty queues, publish-before-ack order and uncertain outcomes. Actual live replay remains unexercised because no confirmed DLQ incident required it; do not manufacture one in an account-recovery acceptance window.
