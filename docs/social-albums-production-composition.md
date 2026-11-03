# Social albums production API candidate

This release composition starts from the verified production runtime
`8c0fe84625c6bcdf269b94f3511b6ef62286f1f6`. It applies only the API,
new migrations and crypto changes from the product branch through `99477e6`,
relative to main `6d3a280`. Production's denial cleanup implementation,
request timing, session preparation, placement and runtime flags are retained.
The CSP adds same-origin/blob media playback needed by the current web client.

This is a backend candidate. The Feed/Share/Albums web assets are built and
verified separately from the product branch. No deployment is implied by this
commit. Migrations 060–067 require staging validation and compatible old/new
client checks before applying them to production. Existing production omissions
052 and 057 remain omitted; the unrelated group invitation roster route and its
main-only acceptance tests are not added by this composition. The existing
production group routes/tests remain, and photo tests also exercise the exact
schema profile without 052/057.

The copied feature suites cover albums, standalone photos, adopted attachments,
archive identities, circles and history defaults. The social HTTP suite now
creates an isolated database and applies this candidate's migration files,
instead of an incomplete historical list. The normal production-baseline CI
remains required, with an additional preserved-schema photo test step.

Live read-only preflight on November 2 verified the provider baseline and schema
fingerprints (60 staging migrations, 58 production migrations), with no provider
or database writes. Fresh gates must be repeated under the release lease before
any activation. Source pinning alone is not production release evidence.
