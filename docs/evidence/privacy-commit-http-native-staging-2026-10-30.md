# Normal HTTP session-revocation acceptance with native R2 evidence

A fresh staging test passed at **03:33:57.250 UTC on October 30, 2026**.
It exercised the normal `POST /api/auth/revoke-sessions` route, verified its
canonical commit marker and ordinary receipt, kept an independent account
available, and removed its exact synthetic fixtures and temporary evidence
transport. This is acceptance of that auth path, not every auth operation or
the monthly availability objective.

## Scope and admission

The test used source `3029ec81fb15336966d2309ea14c1c522be7f35b` with all six
push/PR checks successful. The focused operator-reader/proof suite passed
54 tests; dedicated type checking, formatting and secret checks passed.
The release tooling remained `9ce5e0a84e491e827dc2d5705572f22e47eb3d6e`.

There was no application deployment in this test. Staging remained version
`8bd55c44-10b8-4f3e-a98c-e040af0dcf9d`, executable
`89f03970422e7869002703840b5067e5f585b11e`, with 58 migration entries and both
privacy commit reader/writer flags enabled. Compatible reader floor
`fd35aa2e-f881-46fb-a596-e3d6eb7defb1` remained pinned. Production version
`048cd033-4855-4100-9fc2-d1d179fe398b` and its configuration were unchanged.

Before fixtures, the owned deployment lease, exact source/CI, external production
probes, provider inventory, database schema and fresh pooling evidence were
checked. A temporary operator bridge used native R2 bindings with journal
access restricted to read-only. Its existing conditional-write capability gate
used only its owned probe namespace; the commit-scope namespace was checked
before proceeding. The operator could not write journal intents, scopes,
receipts or control. It independently proved the earlier retained operation's
canonical marker/receipt before creating new synthetic accounts.

## Observed behavior

The new session-revocation request returned HTTP 200 in **3,788 ms** at
03:33:46.359 UTC. Its cookie was subsequently denied. Independent proof at
03:33:48.059 UTC verified operation `7dd0e0e4-b587-4409-a3be-8cbb180575d7`,
sequence `30716`: exact immutable intent/scope hashes, unique SQL fence,
canonical commit marker, ordinary receipt, retired pending intent, deleted
owned session, preserved account and unchanged active journal generation.
The intent timestamp fell inside the request window; no action, receipt,
marker or control update was replayed or synthesized by the observer.

Six continuity samples passed between 03:33:41.584 and 03:33:53.288 UTC,
including two samples after proof. Maximum durations were 459 ms for the
allowed profile, 834 ms for feed, 854 ms for the denied profile and 946 ms for
protected readiness. Nineteen native evidence reads completed without failure;
the maximum was 199 ms. User-journey and continuity budgets remained 10 seconds
and 5 seconds respectively. Evidence reads retained a separate 10-second read
limit and 60-second proof budget.

The surviving account logged out normally and its old cookie was denied.
Exact owned fixture rows were verified absent, private cookie/password files
removed, and the temporary Worker/domain teardown verified. Final provider
inventory matched the baseline and the deployment lease was released.
Private evidence is under
`artifacts/private/journal-commit-http-native-staging-20261030/`.

## Failed REST attempts remain failed

The [earlier writer activation](privacy-commit-http-writer-staging-2026-10-30.md)
required retrospective proof after its evidence check failed. Two subsequent
standalone REST-based attempts stopped at evidence-reader admission before
creating fixtures or sending auth mutations; their leases were reconciled and
released. Neither was replayed.

Instrumented preflight located an operator journal API GET timeout. A bounded
REST attempt exhausted all three 10-second GET deadlines. In a separate paired
diagnostic, both default and dedicated HTTP connections timed out once, then
succeeded on their second attempts. Another read-only check passed in 3,065 ms.
These observations do not establish a provider or local-network root cause.
They also do not demonstrate an application outage: independent production
probes and staging readiness remained healthy during these observations.
The new native test is a separate successful run; it does not erase those
failures or establish that REST transport is reliable.

## Remaining acceptance

Actual writer-enabled rollback to a compatible reader, credential changes and
other relevant auth paths, concurrent workload and load/cost measurement remain
required before production writer admission. The earlier activation continuity
and this HTTP acceptance are separate observations, not a concurrent daily
feature-release rehearsal. Scheduled feature delivery, old/new client overlap,
owner/device/inbox checks, power/network redundancy and measured monthly
availability remain open under #1 and #42. Generic pre-SQL publication failures
and Cloudflare isolate loss are not resolved or proved by this test.
