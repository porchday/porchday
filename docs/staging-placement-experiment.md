# Staging API placement experiment

Compare identical API and public asset bytes with no placement versus
`aws:us-west-2`, while public files use Cloudflare's asset-first routing. This is
an experiment, not approval to change production placement or domain routing.
Force `/api`, `/api/*`, `/health` and `/.well-known/*` through the Worker;
all authentication, privacy guards, RLS, expiry and no-store behavior remain.
Static responses use `_headers` to preserve the API middleware's security
headers. Dynamic public request IDs/aggregate Worker invocation metrics are
absent on direct assets. Keep the same public content, cache directives,
service worker and navigation behavior. Verify headers and bytes after upload.

The existing staging Worker was already placed in Oregon, but its public
assets passed through that Worker. Separate asset routing before comparing
edge API execution against placed API execution; comparing old production
with staging would confound source, data and routing.

The manual `Measure synthetic staging latency` workflow runs only on main.
Supply a short-lived existing synthetic staging session in the ephemeral
`PORCHDAY_STAGING_LATENCY_COOKIE` repository secret. Never supply production,
operator or member credentials. The script sends it only to two fixed staging
API read routes, refuses redirects, consumes/discards bodies, and prints only
numeric timing, deployment/edge identifiers and public content/header evidence.
It makes 20 measured requests per route plus one warm-up. It reports approximate
IP geolocation and per-request Cloudflare edge; neither alone proves physical
runner location. No private artifacts are uploaded. Revoke the test session and
delete the secret immediately after the comparison, and verify both actions.

Compare US West Mac mini and, if available, a corroborated US East runner for
signed-in `/me` and `/feed`, plus `/app-shell` and a public script. Nick supplies
Asia observations. Require public-content/security/cache/navigation parity and
no worse signed-in US West/East p50/p95 before considering production placement.
Noisy or missing evidence fails that gate. Legacy production redirects and
old-origin account/key access must also be preserved before any production
asset-routing change; staging alone cannot establish that parity.

Keep immutable intent/upload/activation/verification receipts for each version
and record the current staging experiment in the latest deployment baseline.
Never retry an uncertain provider mutation. Revert to the preceding verified
staging version if checks fail. A future deploy must explicitly preserve or
end the experiment; the ordinary renderer still selects Worker-first assets.

References:
- https://developers.cloudflare.com/workers/configuration/placement/
- https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
- https://developers.cloudflare.com/workers/static-assets/headers/
