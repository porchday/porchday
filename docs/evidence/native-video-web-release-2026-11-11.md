# Native-aware video guidance production release — November 11, 2026

Runtime source `565c52097c3d97772c5a815f7ec2f42a0b5aec15` from [PR #220](https://github.com/porchday/porchday/pull/220) is now deployed to staging and production. This completes the web portion of the [native video fix](native-video-service-workers-2026-11-11.md). Older native shells now receive TestFlight update guidance, and unsupported browsers receive browser guidance. The misleading “Try the native app” instruction is removed. Native playback requires the corrected installed binary: internal TestFlight iOS 424 / macOS 410.

- Staging frontend: `170bab0e-9138-4fe4-b634-552e0f1a913a`.
- Production frontend: `a08aa883-4c28-4578-bb10-e75f815abe2c`.
- Backend Workers and database schema were not changed.

## Verified

Exact-source full CI, secret scan, iOS simulator and macOS checks passed. The maintained activation CLI enforced native parity. Local regression checks cover old-native, unsupported-browser and service-worker-initialization guidance. Forward and rollback asset checks passed.

Both environments passed old-tab/fresh-client checks, authenticated continuity, hosted exact-asset checks, and deployed player-copy verification. Draft persistence, encrypted photo reads and automatic-update checks passed. Candidate continuity recorded 15 staging samples and 25 production samples, with zero failures and two post-command samples in each. Owned synthetic fixtures were cleaned; no deployment lease remains.

## Preserved release interruptions

Cloudflare changed the representation of the existing Oregon backend placement from target ID 2 to its region name, and omitted the ID from version resources. Under the shared release lock, two independent reads verified that only those exact fields changed; all other inventory fields matched. The recorded inventory pointer was reconciled without provider writes.

An initial staging rollback-ready attempt stopped with a prepared journal and no provider-write intent. A read-only authorization check passed; the attempt was cancelled through maintained tooling and its fixtures cleaned. A fresh activation then passed browser/journey checks and reached complete, but finalization encountered a retryable provider observation error. The maintained read-only finalizer reconciled the completed activation without another deployment. Its original command failure remains recorded, alongside 14 healthy continuity samples, four after completion, and verified cleanup. Follow-up is tracked in [#3](https://github.com/porchday/porchday/issues/3).

## Monitoring limitation

The initial post-activation monitor window **failed**: one journey at 2026-11-11T16:02:58.283Z exceeded its 10-second budget. The feed read took 5,288 ms; logout began with 4,115 ms remaining and reached the deadline waiting for headers. Revocation had no budget left. The underlying cause and relationship to this deployment remain unconfirmed.

A separate recovery window subsequently passed: **8 consecutive healthy probes across 140034 ms**, with no further failures in that window. This does not erase the failed initial window or establish a wholly failure-free release. Both records are preserved in [#55](https://github.com/porchday/porchday/issues/55).

Physical playback/seeking of the reported clip on the updated iPhone and Mac remains unperformed and tracked as `needs verification` in #49/#114. Native capability tests and hosted browser checks do not substitute for that device check.
