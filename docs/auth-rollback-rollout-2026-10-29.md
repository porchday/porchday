# Confirmed auth rollback rollout — October 29, 2026

PR [#79](https://github.com/porchday/porchday/pull/79) preserves an acknowledged
pre-COMMIT rollback so a failed auth operation can retire its journal intent
through the normal checkpoint and completion receipt. It still returns the
original request failure. An attempted COMMIT, lost ROLLBACK reply or failed
receipt receives no new completion proof. No quarantine or historical intent is
cleared by this patch.

The generic-error reproducer fails on the previous implementation. The deployed
candidate passes 125 tests across seven auth, journal, recovery and session-denial
suites against disposable PostgreSQL, API typecheck, formatting and secret checks.
Exact-source push CI passed for runtime
`c57e0278bfc97026011a4737e6f05a5083a98e77` and release tooling
`de8f2ce02e46f00abeb3dcaea180e24b6343d2d4`.

The runtime is the deployed `52949ef` source plus this fix, retaining all deployed
session-denial readers. There were no schema, flag, topology or frontend changes.
Writers and cleanup for the separate session-denial design remain disabled.

## Hosted deployment evidence

The maintained inactive-upload command performed one dispatch per durable intent,
then verified the candidate using read-only provider reconciliation. Both uploads
retained existing assets. Exact executable bytes, the previously reviewed map
transformation, all 46 first-party source files, schema and resource inventory
passed. Upload receipts were archived before separately acquiring activation leases.

| Environment | Active version | Activation operation |
| --- | --- | --- |
| Staging | `11825dfb-9968-471c-a94c-24e60a51f71f` | `a8c92c1d-9bf1-4539-8c13-174f0dda7dc8` |
| Production | `4771f4b0-dff5-456e-bc98-a616b9f62e2d` | `af2ac8b6-672c-46f1-bcac-48d0b4957170` |

The repository deployment controller used durable intent, provider observation,
compatible rollback authorization and terminal-state finalization. A private,
source-pinned operator adapter supplied the actual provider/schema authorization
and synthetic-account checks; a general maintained activation CLI is still needed.
Neither rollout needed rollback.

Staging recorded seven successful existing-session reads from 01:52:41.518 through
01:52:50.716 UTC. Production recorded seven from 01:54:27.626 through 01:54:36.842
UTC. Both also passed new login, authorized profile/feed reads, logout, rejection
of the logged-out session and protected readiness. The continuity session was
logged out and rejected after each rollout. All test session files were removed
only after verified logout; account credentials remain private.

Public checks preserved 26 staging asset files, including retained experimental
bundles, and 24 production asset files. Both production domains reported the new
version, anonymous session availability and healthy protected readiness at
01:55:02 UTC. Canonical runtime versions and provider snapshots were finalized,
and both deployment leases were released.

Private evidence is retained under `confirmed-auth-rollback-20261029` in the
operator's private artifact directory. It includes upload manifests/proofs,
activation plans, immutable journals, continuity observations and logout receipts.
Never rerun an uncertain provider or auth write with a new operation identifier.

## Limits

These short continuity samples support a successful observed rollout; they do
not establish uninterrupted service for every member, native-device compatibility,
regional performance or 99.99% monthly availability. No production fault was
injected. Aggregate incident telemetry does not prove that the corrected defect
caused the earlier outage. Durable recovery, broader journey coverage and the
complete availability measurement window remain open.
