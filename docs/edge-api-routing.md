# Public edge and placed API routing

The optional `porchday-{environment}-edge` front end runs with placement off.
It serves public navigation through the same Hono application/domain/security
middleware and ASSETS binding as the application Worker, at the incoming edge.
It has no database, storage, auth secrets, scheduled events or queue consumer.
Public assets are Worker-first locally, rather than bypassing domain middleware.
This preserves HTTP/HTTPS, canonical, legacy and www behavior, including legacy
account access and noindex headers. It does not create an HTTP asset cache.

Exact `/api` and `/api/*` requests go unchanged through the API_BACKEND service
binding to the existing application Worker, which can be placed in Oregon.
The backend still validates the original origin and performs every fresh
security check. No URL, body, cookie, authorization or Origin header is rewritten.
Well-known requests also go to the backend for its native-app configuration.
Binding failures return a sanitized private/no-store 503 with no retry.
The public `/health` is local and identifies the front-end version; protected
API health is served by the backend. Check both deployment IDs during a rollout.

`scripts/configure-edge.py staging|production` generates the front-end config.
Reassign existing custom-domain bindings to the edge front end only after it
is verified; preserve hostname, zone and TLS registration. Record each original
domain ID and service target. Use the account Workers Domains API, not zone
route overlays, and verify the complete before/after domain set. Keep logs/traces disabled. Never attach
backend queue consumers or cron triggers to the front end.

Deploy matching public assets and backend source through staging first. Verify
inactive version bytes/bindings, then activate and verify health, headers,
navigation, redirects, legacy account/key-access paths and synthetic signed-in
reads/writes. A front-end code test alone is not hosted service-binding evidence.
Existing renderer defaults are not an approval to undo placement or overlays;
future releases must explicitly preserve or retire this topology and update
the edge assets as well as the backend. Do not serve mismatched web/API builds.

Before promotion, save both active versions, provider settings and route set.
Rollback deploys the retained backend version at 100% and restores each
custom domain's recorded original service target, without deleting domains.
Verify domain ownership/current deployment immediately before each mutation;
never overwrite a later release or retry an uncertain mutation. Check public
and protected health, active IDs, per-version placement/assets/bindings, public
file hashes and domain behavior afterward. Version rollback does not undo data
or migrations; routing/placement releases must not require a schema rollback.

The latency probe logs only fixed path/stage, HTTP status, elapsed time, completed
sample count and allowlisted validation/network error codes on failure. It never
logs exception messages, private bodies, credentials, full request headers or
arbitrary URLs. Preserve incomplete attempts separately from completed samples.

References:
- https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/
- https://developers.cloudflare.com/workers/static-assets/binding/
- https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
