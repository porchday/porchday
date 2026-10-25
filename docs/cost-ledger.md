# Setup spending and recurring resources

Authorized ceiling: $1,000 total setup spending, including previous setup activity. This is not a monthly authorization or a spending target.

| Resource | State | Cost evidence / next verification |
|---|---|---|
| Cloudflare Workers Paid | Owner enabled before build | Verify current subscription and measured usage before final cost report. |
| R2 staging and production buckets | Separate media and recovery-journal buckets created; managed public access disabled | Empty at provisioning. Usage charges accrue with storage/operations; journal data is separate from restorable application storage. |
| Cloudflare staging and production queues | Created, including dead-letter queues | No deployed producer traffic yet. Verify request charges after tests. |
| PlanetScale billing integration | Owner activated; organization linked | Database not yet created; no new database size selected or committed by this build. |
| Cloudflare Email Sending | Enabled; one setup-test message queued | Delivery and billed usage verification pending. |
| Temporary R2 operator Workers | Conditional-write probes deployed and removed temporary Workers/custom domains | Probe requests may incur ordinary Workers/R2 usage. No persistent operator endpoint remains after verified teardown; no media/journal contents were published. |
| Independent monitor | Worker/Durable Object code and configs prepared, not deployed | Planned minute cadence is about 43,200 checks per environment per 30 days, plus public status reads and incident emails. Measure actual usage after deployment. |
| Operational metrics probe | Three temporary isolated Workers/custom domains emitted six synthetic Analytics Engine points; every Worker/domain was removed and teardown independently verified | No member data or database access. The isolated verification dataset retains the synthetic records under provider retention. Worker/API usage may accrue; Analytics Engine's current pricing status and future allowances are recorded in `docs/operational-metrics.md`. |
| GitHub private repository | Implementation pushed; Linux and hosted macOS simulator CI executed | The successful native run 40173186675 took 300 seconds; its timing endpoint reports 0 billable milliseconds. This does not prove total setup cost is zero. Account-wide billing API requires an additional user scope and is currently unavailable. |
| Local tooling | npm dependencies, Go and PlanetScale CLI installed | No purchased software. Hosted CI verifies iOS simulator builds; local Xcode is optional for that verification path. |

No claim of zero provider spending is made until the billing data is checked. Provider alerts are not hard spending caps. Track both accrued charges and newly committed recurring costs; pause new spend before the authorized total would be exceeded. Establish a separate operating budget before a real pilot.

On 2026-10-25, the Cloudflare Notifications API verified an existing enabled account-wide billing budget alert at $10 of usage charges, with one email recipient matching the configured account owner. The policy is retained. Actual alert delivery has not been exercised. This alert resets each billing period and excludes fixed subscription charges; it is not the cumulative $1,000 setup ceiling or a hard cap. [Cloudflare budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)

Cloudflare subscriptions and billable-usage requests currently return HTTP 403 under the deployment token. The GitHub user billing endpoint returns HTTP 404 with an explicit missing `user` scope. Exact accrued spending therefore remains unverified; obtain billing visibility or owner-provided invoices before committing substantial new recurring resources. PlanetScale has not yet been provisioned. No resource tier was upgraded during this checkpoint.

Current PlanetScale planning baseline is $50/month for production PS-20-ARM high availability plus $5/month for single-node staging, before storage/backup overages and other services. These are proposed resources, not purchased commitments. Official live-price evidence, role/backup restrictions and region details are recorded in [PlanetScale readiness](planetscale-readiness.md). Load testing must justify the final tier before deployment.
