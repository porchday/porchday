# Concurrent authentication commit regression coverage

Two new SQL-backed cases passed on October 30, 2026, followed by all **27 tests**
in `auth-journal.integration.test.ts`. API type checking, formatting, secret
and diff checks passed. No hosted application or provider settings changed.

The cases dispatch normal `revoke-sessions` requests for two and four distinct
synthetic accounts through the real auth routes. A test barrier holds every
immutable intent publication until all requests arrive, then releases them
together. This exercises overlapping registration and completion against one
journal, rather than merely calling requests one after another.

Each case verifies:

- Every response succeeds, with exactly the expected number of distinct SQL
  commit fences and original intents.
- Every fence has a matching canonical commit proof and ordinary receipt.
- The journal remains active with no pending intents; SQL is not quarantined
  and agrees with the journal generation.
- Every revoked session is absent and its cookie yields an anonymous session,
  while the accounts themselves remain present.
- A separate account's session remains usable.

The test uses a dedicated disposable PostgreSQL database, real migrations and
restricted auth/jobs roles. R2 is represented by the suite's in-memory store
with conditional writes; the barrier is test instrumentation. Email is captured
locally and external password-reputation reads are mocked. This is not hosted
concurrency, provider latency, capacity or network-failure evidence.

The focused two cases passed in a filtered run; the subsequent full suite passed
without skipped tests in 47.75 seconds. The per-case 15-second test deadline was
not increased. No runtime implementation change was needed for these cases.

Hosted simultaneous writes remain an acceptance requirement. The separate
[candidate-write rollback test](privacy-commit-write-rollback-staging-2026-10-30.md)
proves one write survives rollback, not these concurrent cases. Hosted password
change also remains pending: its actual route queues a security email and needs
an approved test inbox. Neither result establishes monthly 99.99% availability.
