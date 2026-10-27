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
`edge_frontend: true` in the resource manifest leaves backend routes empty;
the edge renderer owns all custom domains. Staging selects Oregon API placement with the edge front end. Production
returned to placement off and backend-owned domains after the October 27
automatic watch rollback. The production front end remains unrouted. Do not
re-enable production placement or transfer its domains without renewed
verification; see issue #9. Future releases must update edge assets and backend together,
or explicitly retire this topology. Do not serve mismatched web/API builds.

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

## Member-based placement watch

The October 27 operations-health rollback used ten requests per checkpoint;
nearest-rank p95 with ten samples is the maximum, not a stable tail estimate.
Operations-health performs fresh journal R2 and jobs-SQL reads, closes the journal
SQL client, then opens a separate jobs client for the combined operational and
backup snapshot and closes it. Placement does not add queries. Instrumented
successful, capability-authorized health responses expose only numeric journal,
snapshot, close and total Worker durations, allowing connection/storage time to
be distinguished from client-to-Worker transport. No denial timings or bodies
are logged and no fresh privacy/authentication check is cached or removed.

`scripts/placement-watch-policy.mjs` evaluates at least 30 attempts for each of
signed-in `/api/v1/me?bootstrap=1` and `/api/v1/feed?limit=10` from the same US
probe, using a separately owned synthetic fixture. Latency comparison requires
30 successful samples per route in both baseline and current windows. All
attempts and failures remain recorded. Median or p95 degradation exceeding both
15% and 20ms is a reason; three or more failed requests with an error-rate
increase over two percentage points is independently a reason. Aggregate API
5xx rates use the same error rule with at least 20 requests. Two consecutive
checkpoints with the same reason trigger the guarded rollback. A changed
release or domain set stops the watch rather than rolling back another release.
Missing credentials, insufficient samples or unavailable aggregate errors must
be reported as incomplete coverage, never silently treated as healthy.
Operations-health remains a warning only, including latency and failed checks;
it never supplies a rollback reason. Keep public bytes/caching and front-end
health verification separate. Retain the prior backend and original domain
records before any promotion; bound the watch to one hour and clean up its
synthetic session afterward. A synthetic empty feed is not representative load
or proof of Philippines latency; report that limitation with the measurements.
