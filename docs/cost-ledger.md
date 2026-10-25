# Setup spending and recurring resources

Authorized ceiling: $1,000 total setup spending, including previous setup activity. This is not a monthly authorization or a spending target.

| Resource | State | Cost evidence / next verification |
|---|---|---|
| Cloudflare Workers Paid | Owner enabled before build | Verify current subscription and measured usage before final cost report. |
| R2 staging and production buckets | Created; managed public access disabled | Empty at provisioning. Usage charges accrue only with storage/operations. |
| Cloudflare staging and production queues | Created, including dead-letter queues | No deployed producer traffic yet. Verify request charges after tests. |
| PlanetScale billing integration | Owner activated; organization linked | Database not yet created; no new database size selected or committed by this build. |
| Cloudflare Email Sending | Enabled; one setup-test message queued | Delivery and billed usage verification pending. |
| GitHub private repository | Existing and accessible | CI usage not yet measured. |
| Local tooling | npm dependencies, Go and PlanetScale CLI installed | No purchased software. Xcode installation pending owner. |

No claim of zero provider spending is made until the billing data is checked. Provider alerts are not hard spending caps. Track both accrued charges and newly committed recurring costs; pause new spend before the authorized total would be exceeded. Establish a separate operating budget before a real pilot.
