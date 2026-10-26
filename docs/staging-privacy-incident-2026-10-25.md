# Staging privacy checkpoint incident — October 25, 2026

The owner’s email-change approval link returned `PRIVACY_CHECKPOINT_REQUIRED`. Staging had entered quarantine because a background privacy operation started at 02:39:48 UTC October 26 and did not record a completion receipt. The read guard blocked the request before email-token validation. The link subsequently expired; this attempt does not establish completed email-change acceptance.

Production’s protected health checks remained healthy during the investigation. No production recovery was performed.

## Evidence and recovery

The precise background failure is unknown. Existing telemetry collapsed failures from multiple cleanup phases into `cleanup_retry`, so equal database and journal cursors were not taken as proof that the failed operation rolled back.

The operator verified the original PlanetScale staging `main` branch, unchanged Hyperdrive routing and storage bindings, the complete available provider audit, matching database and journal generation/sequence 201, and no expired-content or pending-deletion obligations. The one unresolved intent had its durable intent object and no completion receipt. Queue delivery was paused without purging queued work or changing the consumer. Separate read-only database observations showed drained writers and identical fingerprints across 26 account, session, key, invitation, recovery and capability tables.

Reviewed source `5030a5beb58bc2750211adb7ebf7de527569beec` adds a staging-only original-primary recovery command. It requires fresh evidence, an exact clean reviewed checkout, verified database TLS and source/resource pins. It verifies the journal chain, media and capability inventory before writing an evidence-linked receipt and one conditional update to reopen the journal. It does not change SQL or revoke capabilities. Conflicts or uncertain outcomes require inspection rather than automatic retry. See [the operator procedure](restore-safety.md).

The command completed successfully, resolving one intent at sequence 201. Independent readback at **04:10:18 UTC** confirmed active mode, zero pending intents, all 26 fingerprints unchanged, three sessions and one integration grant preserved, and removal of the temporary authenticated operator Worker and domain. Queue delivery was resumed with the other settings and consumer unchanged. Protected staging health then returned 200 with no issues and a fresh cleanup heartbeat. At **04:12:03 UTC**, the journal was active with zero pending intents and no deletion, identity or email backlog. A further observation at **04:13:23 UTC** found both environments healthy and both independent monitors operational with metrics ready; staging still had no pending intents. These observations establish recovery of this incident; they do not establish its exact initiating cause or guarantee no recurrence.

Owner-only evidence, invocation intent, result, independent verification and queue-resume receipts are retained under the ignored `artifacts/private/restore-ops/staging-original-recovery-20261026*` paths. Provider and preflight observations are under `artifacts/private/hosted-smoke/staging-journal-incident-20261026*`. Evidence is preserved in the primary workspace before removing the temporary recovery checkout. Credentials, email links and raw account rows are not committed.

## Related email-link correction

Investigation found that an email-change verification link could be consumed when opened while signed into a different account. The correction rejects that mismatch before creating a privacy intent or recording link use, and rechecks it inside the identity lock. Same-account approval, signed-out verification and replay protection remain covered by real-database tests. This is separate from the checkpoint outage; it was not established as its cause.

The recovery and email-link changes passed focused PostgreSQL tests, adjacent journal/restore tests, R2 transport tests, TypeScript checks and the credential-pattern scan. [Linux CI on the exact reviewed revision passed](https://github.com/bobbyhwilder/porchday/actions/runs/40266819838). Reviews were internal, not an independent security audit.

A follow-up diagnostic change records only fixed phase codes for journal begin/work/completion/close and each cleanup step. Existing retry, acknowledgement, error propagation and quarantine decisions remain unchanged. Nineteen new failure-injection tests cover phase attribution, secret omission, unavailable telemetry, unresolved intents and completion followed by connection-close failure; 56 tests passed with adjacent PostgreSQL/privacy suites, along with the API typecheck and credential-pattern scan. This improves evidence for a recurrence without claiming to prevent the unknown original failure.

The expired email-change attempt must be restarted with a fresh request when the owner is available. Old-address approval alone must leave the account address unchanged; only subsequent verification at the new address may change it and revoke old sessions. Member-invitation recipient signup and verification also remain separate inbox acceptance work.
