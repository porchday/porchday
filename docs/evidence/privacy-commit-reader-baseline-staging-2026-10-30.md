# Compatible reader baseline activation

Staging activation and fixture cleanup passed at **03:45:06.221 UTC on
October 30, 2026**. Version `1400851f-25d3-4c6c-884b-c7c5710a8505` replaced
`8bd55c44-10b8-4f3e-a98c-e040af0dcf9d`, preserving executable
`89f03970422e7869002703840b5067e5f585b11e` and all 58 schema migration entries.
Only the privacy commit writer flag was removed; its compatible recovery
reader remains enabled. Session denial writing and cleanup remain enabled.

The candidate resources exactly matched the retained reader floor
`fd35aa2e-f881-46fb-a596-e3d6eb7defb1`. This is a fresh version with equivalent
resources, not a claim that the old version itself was deployed. The retained
floor was not promoted or changed. Production and frontend versions were
unchanged.

Admission included all six successful checks for source
`7f8ba9ca7a400e46fb112d4b5b6f78465ea1ad29`, unchanged executable provenance,
37 resource admission checks, 11 compatible installed watcher modules, and a
16-read observer test. Native read-only preflight confirmed active journal
control with no pending operations, healthy protected readiness, and verified
removal of the temporary evidence bridge before upload. Tooling remained
`9ce5e0a84e491e827dc2d5705572f22e47eb3d6e`.

The maintained activation controller observed **11 healthy continuity samples**
from 03:44:37.016 through 03:44:57.658 UTC, including two after completion.
Maximum durations were 842 ms for the allowed profile, 873 ms for feed,
581 ms for the denied profile and 795 ms for protected readiness. Maximum
sample start gap was 2,003.990 ms. Journey and continuity budgets remained
10 seconds and 5 seconds. Existing allowed sessions worked and an actually
revoked cookie remained denied across activation.

The surviving synthetic account logged out normally. Both exact owned fixtures
were verified absent, private cookie/password files removed, final provider
inventory verified unchanged after cleanup, and the cleanup lease released.
Private one-shot evidence is retained under
`artifacts/private/journal-commit-reader-baseline-staging-20261030/`.

This establishes a fresh reader-only baseline for a subsequent writer candidate
and deliberate failed-acceptance rollback drill. It does not prove that drill,
concurrent writer activity during deployment, every auth path, daily feature
delivery with old/new clients, production writer admission, or 99.99% monthly
availability. Those acceptance gaps remain open under #1 and #42.
