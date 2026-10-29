# Staging frontend browser-gated round trip — October 29, 2026

The maintained frontend activation wrapper completed both directions of an existing-build
round trip with no observed failed continuity samples. The newer `d6fd3fa` build is
restored. This is normal hosted transition evidence, not a fault-injection drill.

The [structured record](frontend-browser-roundtrip-staging-2026-10-29.json) pins the
versions, operation identities, observation windows and results. Tooling `7d7ee36`
had all six CI checks pass before execution. Each phase used a new inactive upload
and activation, the existing durable controller, compatible rollback authorization,
and a browser gate that persisted acceptance before candidate completion.

| Phase | Samples | Failed | Post-command samples | Maximum start gap | Fixture rows remaining |
| --- | ---: | ---: | ---: | ---: | ---: |
| Return to retained `b2b3a069` | 11 | 0 | 2 | 2002.25 ms | 0 |
| Restore newer `d6fd3fa` | 12 | 0 | 2 | 2002.61 ms | 0 |

Each browser check retained the old form state, loaded one previously cold lazy
entrypoint with exact retained bytes, and verified the new document and login
rendering. Both old and fresh contexts had zero JavaScript and module-MIME errors.
Separate authenticated API samples checked the existing allowed session and denied
cookie before, during and after activation. These checks do not prove signed-in UI
or installed/native client compatibility.

Final staging frontend is `89eec37f-e097-4e65-9b71-42ad08d854de`, with the original newer
asset source restored. Staging backend `91a0bea2` / source `4ef42377`, schema and
isolated queue configuration were preserved. Production was unchanged. Both phases
verified exact synthetic fixture cleanup and post-cleanup provider inventory; the
deployment lease is free.

The Mac release watcher was also updated to `7d7ee36`. The old process stopped and
released its singleton lock before the new process started. The previously
suppressed alert for a cancelled staging preparation reached the
[exact Actions bot comment](https://github.com/porchday/porchday/issues/3#issuecomment-6510983717); its delivery receipt
persisted and two subsequent polls had no pending notifications or errors. The
original event timestamp and cancellation archive were preserved. This was a
historical notification, not a new outage. Production monitoring remained healthy.

The local regressions cover 94 browser/recovery tests at `2907c6c` and 42
alert/gate tests at `7d7ee36`; the browser implementation was unchanged between those
commits. Hosted automatic browser-failure rollback, daily-release adoption,
physical/installed clients, owner inbox receipt and Mac power/network redundancy
remain open under #3 and #42. Neither this rehearsal nor a healthy monitor proves
the 99.99% monthly objective.
