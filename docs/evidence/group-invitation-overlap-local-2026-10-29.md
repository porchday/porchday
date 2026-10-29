# Group invitation feature release rehearsal

This isolated candidate starts from deployed staging runtime
`770071b75ba82bd6dffb08581bf97da30d696d2a`, restores the deployed web/crypto tree
from asset source `b2b3a069a44e8b9d41feb266671863c23bafa310`, and applies the
already implemented issue #41 feature commits `5cb39e3` and `ef65276` as
`790681b` and `b0d6e59`. The restoration commit is `a247a47`. It preserves the
deployed post-detail reuse, visible timing and byte-copy optimization rather than
regressing those when building the pending feature. Both pre-existing tracing
coverage and the invitation tests were retained when resolving a test conflict.

Migration 052 adds an owner-only invitation roster function, an inviter-column
update grant and an attribution guard trigger. It drops or renames no existing
table/column. This source review alone does not prove migration lock duration,
runtime permissions, rollback compatibility or hosted availability.

## Local verification

A fresh disposable database `porchday_feature_overlap_test_20261029` in the
existing local PostgreSQL 17 container was used. No hosted database or provider
was changed. The social HTTP suite applied its test schema including migration
052. Thirty-two social HTTP and invitation web tests passed, with no skips in
that invocation. Workspace type checks, web production build and all 22 crypto
tests passed. Vite retained its existing large-chunk warning.

The additional overlap case loaded the exact baseline `social.ts` from commit
`770071b` into a temporary adjacent module, supplied through
`RELEASE_BASELINE_SOCIAL_MODULE`, and removed that file after the run. It used
the existing local database URL variable `SOCIAL_HTTP_DATABASE_URL`; local
credentials were loaded internally and not recorded in evidence.

With old and new social route factories using the migrated schema and restricted
runtime role, the old API created a group and invitation, the new API listed and
accepted that invitation, and the old API read the resulting group, profile and
feed successfully. The new owner-only roster denied a non-owner. The old API
returned 404 for the new roster endpoint, making its lack of that feature
explicit. The existing invitation suite also checked pagination, blocked
identities and attribution on reissue.

The temporary baseline route module shared the candidate's database/support
modules; this is not a test of two complete deployed Workers. The overlap case
is conditional on the baseline-module variable and must not be counted as run
by ordinary CI without that input.

## Remaining gates

No migration, upload or activation is authorized by this document. Before a
hosted staging rehearsal, require exact-source CI, current provider/schema
inventory, bounded migration lock/backfill review, immutable assets including
old asset retention, synthetic fixtures and compatible recovery. Use the
reviewed continuity-integrated activation entry point and retain actual provider
milestones. Test an already-open old browser and the new feature UI, plus
supported native behavior. Production promotion additionally needs the current
issue #40 incident/recovery requirements resolved and verified staging evidence.

Issue #3 tracks daily-release reliability; issue #41 remains unverified for hosted
feature acceptance. This local rehearsal does not establish zero downtime or
the monthly 99.99% objective.
