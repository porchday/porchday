# Confirmed auth rollback and journal completion

An auth operation may fail with a generic error even when PostgreSQL acknowledges
its rollback. Previously the privacy journal recognized selected error codes as
known rollbacks, but the auth wrapper discarded the explicit rollback result.
A generic pre-commit error could therefore leave an unresolved intent and later
quarantine unrelated requests despite a confirmed rollback.

The auth wrapper now carries an internal `ConfirmedTransactionRollback` proof
only when the transaction started, COMMIT has never been attempted, and the
ROLLBACK response has command tag `ROLLBACK`. The journal still checkpoints,
writes the completion receipt and retires the intent before rethrowing the
original request failure. The response remains a failure; a failed logout does
not claim that its session was revoked. Existing auth rejection responses are
preserved by unwrapping the internal proof at the route boundary.

A failed/lost rollback response or an error after COMMIT was attempted carries
no new proof. An acknowledged ROLLBACK after a lost COMMIT response cannot undo
or disprove that commit. Those cases retain unresolved intent handling. Failure
to publish the rollback's completion receipt also retains the intent and can
still quarantine. No existing quarantine or journal record is cleared by this
change.

Real PostgreSQL integration tests inject a generic failure after a synthetic
transactional write, a lost rollback response, a lost commit response after the
server commits, and a completion-receipt failure. They check database effects,
session state, HTTP failure and journal behavior beyond the stale-intent window.
The confirmed rollback test fails on the prior implementation and passes with
the change. This demonstrates the defect; aggregate production telemetry does
not prove it caused the October 29 incident. Hosted rollout and validation on
the current reader-compatible production source remain required.
