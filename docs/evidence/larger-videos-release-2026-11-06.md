# Larger video release — November 6, 2026

[PR #167](https://github.com/porchday/porchday/pull/167) adds locally prepared, encrypted, resumable video attachments in posts. Larger uploads are enabled in staging and production. Initial limits are 10 minutes, 1 GiB source, and 250 MiB prepared output, within the existing 1 GiB member media quota. Preparation offers trimming and 1080p or 720p; originals stay on the device. Standalone videos and album placement remain outside this release.

## Deployed sources

| Component | Source | Staging version | Production version |
| --- | --- | --- | --- |
| Web/frontend | `6bfe228` | `0551b167-a66e-45ec-986c-25c00282c4ba` | `f7f88f98-e78c-4d46-b367-086489d5af26` |
| API | staging `615fc42`, production `793d497` | `dd697ab9-57df-45a1-bf55-b34fd613546a` | `2fe11cf0-3619-49e8-80b4-0839bc314919` |

Migration 073 is additive. Each API release preserves its environment's existing queue/session runtime. Video-capable readers were verified before enabling publishing; the recorded rollback floor retains those readers. Publishing can be disabled without removing playback, export or deletion support.

## Validation

- Full local web/API tests: 1,264 passed; 312 environment-dependent tests skipped. PostgreSQL segmented-video and restore-operator suites ran separately, including preserved-runtime migration coverage.
- Browser tests cover range seeking, cross-chunk playback, tab isolation, revocation, durable upload resume, uncertain publication and picker controls. Shared JavaScript/Swift test vectors verify both encryption directions and integrity failures.
- A synthetic 60-second 1080p clip remuxed successfully; 720p preparation reduced approximately 46 MB to 15 MB. WebKit's local preparation storage failure produced explicit fallback guidance; Safari preparation is not verified. HDR currently requires SDR export guidance.
- Exact-source web CI, secret scanning, iOS simulator and macOS build/tests passed. Native tests cover trimming/audio, file-backed archives, corruption and durable retry state.
- Both hosted environments verified real encrypted reservation, partial-upload resume, repeated completion, publication, signed recipient manifest decryption, byte-exact segment playback, seeking through the deployed service worker, bounded export chunks, and denial after removing the connection. Synthetic accounts and media records were cleaned up; encrypted-object deletion uses the durable deletion outbox.
- Production frontend browser compatibility, signed-in continuity, legacy domain/root routes, PWA checks, independent monitoring and the final schema/provider/source audit passed. Private credentials and test fixtures remain outside the repository.

Native CI: [frontend iOS](https://github.com/porchday/porchday/actions/runs/42269481998), [frontend macOS](https://github.com/porchday/porchday/actions/runs/42269482050), [production-source iOS](https://github.com/porchday/porchday/actions/runs/42271398727), [production-source macOS](https://github.com/porchday/porchday/actions/runs/42271398669). Production-source [full CI](https://github.com/porchday/porchday/actions/runs/42271398522) also passed.

Native source/build parity is delivered. Signed installers, TestFlight/App Store distribution and physical-device codec, memory, battery and thermal acceptance are separate follow-ups under [#108](https://github.com/porchday/porchday/issues/108), #49 and #114; no new distributed binary is claimed here.

## Reconciliation

Staging's frontend activation reached the candidate but its initial verification returned unknown. Read-only schema/provider checks subsequently passed. The same operation was reconciled without redispatching activation. Its original browser process was lost; recovery verified reconstructed pinned baseline HTML against retained live modules and a fresh live candidate login. This is not uninterrupted original-tab evidence. Original continuity samples and recovery samples passed. Production's frontend completed normal retained-tab observation without this interruption.

The synthetic live-test script needed module-resolution and connection-ID corrections. Upload, playback and export had completed before the latter error; recovery used the same owned fixtures to finish revocation and cleanup. Production used the corrected script. These were verification-script defects, not application changes.
