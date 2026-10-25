# Hosted synthetic account-deletion verification

`scripts/hosted-account-deletion.ts` is a bounded operator check for **synthetic staging member C only**. It preserves A and B, including B's separate human-controlled recovery-email check. Never execute deletion while a restore drill needs the source account or before its owner releases the journal-cut quiet window. Preparing code and passing local tests do not constitute a successful hosted deletion.

The three explicit phases use `--run`. They accept no alternate account, origin, bucket or arbitrary SQL. Run through the local secret loader, without printing credentials:

```sh
python3 scripts/with-secrets.py npx tsx scripts/hosted-account-deletion.ts prepare --run
python3 scripts/with-secrets.py npx tsx scripts/hosted-account-deletion.ts request --run
python3 scripts/with-secrets.py npx tsx scripts/hosted-account-deletion.ts status --run
```

Run `request` only after the stable-cut authorization. `prepare` logs into C twice normally, verifies the completed synthetic social state and existing account identity, refuses owned groups or pending uploads, and inventories C's devices, authored posts, affected comments and at most 32 live ciphertext objects. It reads and hashes each ciphertext through the provider's authenticated R2 API, checking its exact size and stored raw digest. No object or encrypted payload is written to logs or the ticket. Each expiring object must remain valid for at least fifteen minutes, so an unrelated timeout cannot masquerade as the deletion being tested.

The preparation writes an exclusive, mode-0600 ticket at `artifacts/private/hosted-smoke/account-deletion-c.ticket.json`. It contains member/object IDs, exact R2 keys and checksums, the journal baseline, staging database binding, and two live synthetic session cookies. The file is private, ignored by Git and immutable within the runner. Treat it as a credential-bearing artifact; never attach or print it. It cannot be replaced by rerunning `prepare`. Only fixed labels, booleans, counts and operational timestamps appear in terminal output.

`request` revalidates the ticket, unchanged object inventory, original ciphertext and an active stable journal. It obtains a fresh normal C login and writes a separate exclusive intent, tied to the ticket's SHA-256, **before** issuing the single `DELETE /api/v1/account` request with `{ "confirm": "DELETE" }`. A receipt is written only after the real API acknowledges success. The script does not call SQL deletion functions, delete groups, write R2 objects, force queues, alter outbox completion or change the journal. A repeated intent is refused. If the connection fails after submission, inspect `status` and the private evidence; do not automatically retry or erase the intent. Missing acknowledgement remains explicitly unverified even if later inspection proves the account is gone.

`status` performs one bounded observation, without a sleep loop. It checks:

- All three saved sessions are denied, the auth session endpoint identifies no user, and fresh sign-in with the old password fails.
- C's live member/profile/device/recovery-key/backup rows, authored/cascaded content, relationships, grants/transfers, push subscriptions and auth identity/session/password/MFA/contact/email rows are absent. A and B remain active, verified identities.
- The database has C's durable deletion marker and the expected identity/media outboxes. Read-only R2 checks find no live ciphertext at every original exact key.
- The external journal's existing hash-linked chain contains the new member deletion and all corresponding media-object deletion decisions after the ticket's baseline, without changing journal mode or writing a control object.
- Normal identity cleanup has completed and removed matching invitation/verification metadata. Every media outbox shows at least two actual attempts and completion no earlier than ten minutes after its creation, matching the late-upload cleanup floor.

The PostgreSQL connection requires the exact staging branch suffix, TLS verification and server-enforced `default_transaction_read_only`; queries select metadata/counts only. The R2 transport has GET capability in code only, validates both expected buckets, bounds streamed object sizes, refuses redirects and never follows an arbitrary key from member content. The journal inspection is capped at 128 batches of at most one MiB each. The status window is limited to 24 hours after the intent, and private files are capped by the existing one-MiB guarded-file reader.

Observe once soon after acknowledgement, then again after the normal ten-minute worker floor (allow time for the scheduled queue). `complete:false` is pending evidence, not a successful physical-deletion result. Do not shorten the floor or mark outboxes complete for the test. The first successful observation is retained in a separate exclusive private file. Subsequent results include minimum cleanup-attempt count, final-pass age and the number/latest expiry of completed backup inventories still referencing the object. The runner records status privately and marks only C deleted in the shared smoke state once acknowledgement, authentication checks, live database erasure, external journal evidence, R2 absence and both cleanup phases all pass. The immutable ticket/intent/receipt remain for private audit and later operator cleanup.

This verifies the exercised live-account deletion path. It does **not** claim immediate erasure of every retained copy: bounded database/R2 backups retain ciphertext until their retention policy expires; the independent journal and deletion ledger intentionally retain minimal safety metadata so a restore cannot resurrect acknowledged deletions. Separately disclosed moderation/recovery evidence follows its documented retention policy. Recipient-controlled downloads and independent exports cannot be recalled. The existing isolated restore drill is separate evidence for replaying these safety decisions.

## Evidence status

On October 25, 2026, hosted preparation captured one existing C post and one live ciphertext photo, along with two authenticated sessions and C's device IDs. The request was submitted once at **17:43:57.322 UTC** and acknowledged by the real account API at **17:44:00.362 UTC**. No group, SQL deletion, queue-forcing or R2 mutation bypass was used.

Initial observation at **17:46:37.466 UTC** verified revoked sessions, denied old-password login, absence of the checked live account/auth rows, preserved active A/B identities, external member/media deletion decisions, completed identity cleanup and absence of the exact live R2 photo object. The delayed media pass was still pending, so this observation explicitly reported `complete:false`.

The first observation attempts exposed an operator-verifier parameter-encoding bug: `fetch_types:false` did not supply automatic UUID-array serialization. The read-only checks were corrected to use explicitly bound JSON lists with PostgreSQL element conversion; closed phase/SQLSTATE diagnostics contain no parameter values. This did not cause a second DELETE request or alter the service's deletion behavior. Five boundary tests and targeted TypeScript checks passed after the correction.

Final observation at **17:55:52.444 UTC** reported every required check true and `complete:true`. The normal media worker had made two attempts; the final pass completed 655 seconds after outbox creation, beyond the ten-minute floor. No operator forced a queue or marked an outbox complete. The original live R2 object remained absent, all captured sessions and the old password were denied, checked live identity/content rows were erased, external deletion decisions were verified, and A/B remained active. Only C is now marked deleted in the private smoke state.

One completed backup inventory still referenced this ciphertext, with its recorded expiry at **November 1, 2026, 17:34:22.769 UTC**. This live-deletion result does not claim that the retained backup was already erased. Later restore handling must replay the independent deletion journal before serving restored data.
