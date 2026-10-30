# Writer candidate rollback with live session continuity

The staging drill passed at **03:53:48.643 UTC on October 30, 2026**.
The maintained controller activated a privacy commit writer candidate, observed
an intentionally injected browser exception, and verified rollback to the
compatible reader baseline. All 17 authenticated continuity samples passed.
Production was unchanged.

## Deployment and failure scope

Candidate `531935d0-1b35-4142-9756-d39beaba2bdc` added only
`PRIVACY_COMMIT_WRITER_V1=true` to baseline
`1400851f-25d3-4c6c-884b-c7c5710a8505`. Both used executable
`89f03970422e7869002703840b5067e5f585b11e`, the same 58-entry migration ledger,
and enabled privacy commit recovery. Frontend assets, session denial controls,
isolated queues and consumer caps were unchanged. The retained reader floor
`fd35aa2e-f881-46fb-a596-e3d6eb7defb1` was not promoted.

Upload operation `fb4f4096-2c5a-47b7-b67c-4741b2fb8956` verified the inactive
candidate before activation. Activation operation
`c8644e41-f9cc-4ab9-a3bb-340dc4e88f17` used
`executeStagingApiRecoveryDrill`, which restricts this fault to staging and
requires unchanged public assets. The deliberate exception was confined to
the observer's fresh browser context; it did not inject an application outage.

At 03:53:25.135 UTC, browser evidence recorded the expected exception and
failed candidate acceptance. The old tab retained its document and loaded its
previously cold lazy module with correct bytes and MIME type, with zero old-tab
errors. The fresh login rendered and matched the expected document but recorded
the one deliberately injected JavaScript error. The controller restored the
reader baseline and reached `rolled-back`; it did not mark the candidate healthy.

## Continuity, cleanup and notification

Seventeen samples covered activation, candidate observation, rollback and two
post-command observations from 03:53:11.527 through 03:53:43.927 UTC. All passed:
the existing allowed session could read its profile/feed, an actually revoked
cookie remained denied, and protected readiness stayed healthy. Maximum
durations were 780 ms for profile, 801 ms for feed, 647 ms for denial and
767 ms for readiness. Maximum sample start gap was 2,003.831 ms. Journey and
continuity budgets remained 10 seconds and 5 seconds.

The surviving synthetic account logged out normally. Both exact owned fixtures
were verified absent, cookie/password artifacts removed, final provider
inventory verified, and the cleanup lease released. Staging finished on
`1400851f-25d3-4c6c-884b-c7c5710a8505`, with the privacy commit writer absent
and recovery enabled. The newer writer upload remains inactive. Production
remained `048cd033-4855-4100-9fc2-d1d179fe398b`.

The independent Mac watcher delivered the explicitly labeled
[notification drill through the GitHub Actions bot](https://github.com/porchday/porchday/issues/3#issuecomment-6514550400)
at 03:53:59 UTC, mentioning the repository owners. Its subsequent poll recorded
zero pending deliveries and zero errors. This proves bot-comment delivery,
not human inbox receipt or responder acknowledgement.

## Admission and limits

All six CI checks for source `d72f9cc36871a9dbed3e40c4d57a37180065819c` passed.
Tooling remained `9ce5e0a84e491e827dc2d5705572f22e47eb3d6e`. Local checks included
38 resource admission cases, 44 controller/browser-gate tests, forward and
rollback observer tests with 16 reads each, and local Chromium launch/render.
Native read-only preflight found active journal control, no pending operations
and healthy readiness; temporary bridge teardown was verified before upload.
Provider pooling configuration, source provenance and installed watcher
compatibility also passed. Private one-shot evidence is retained in
`artifacts/private/journal-commit-writer-rollback-staging-20261030/`.

This proves actual writer-configuration activation and rollback with existing
sessions. It does not prove new writer operations concurrent with deployment,
all auth paths, signed-in browser interactions, installed/native clients,
production writer admission, or scheduled daily feature delivery. Those remain
acceptance requirements. Browser asset checks were unauthenticated; authenticated
continuity was separate API sampling.

The external report at 03:50:32.203 UTC still found October's sampled failures
above its error budget: 8,480 estimated failed bucket seconds versus a 267.84-second
full-month allowance, with only 4.42% month-to-date observation coverage.
These are limited synthetic bucket estimates, not continuous uptime; unknown
time stays unknown. Neither this drill nor recent healthy probes establish
99.99% monthly availability. Issues #1 and #42 remain open.
