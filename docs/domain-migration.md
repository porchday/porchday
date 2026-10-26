# Moving the primary website to porchday.org

The public cutover to [porchday.org](https://porchday.org) completed on October 26, 2026. Both `.org` and `.com` apex domains and their `www` aliases are attached to the existing production Worker. Public `.com` navigation forwards to `.org`; existing-device account and API access on `.com` remains available. [Issue #17](https://github.com/andyk/porchday/issues/17) records the dated deployment evidence and device-acceptance follow-up. This is a completed public-address change, not retirement of the legacy origin.

## Domain behavior

Production configuration uses `APP_URL=https://porchday.org` and the explicit transition setting `LEGACY_APP_URL=https://porchday.com`. Both apex domains and their exact `www` aliases attach to the existing production Worker. The database, member IDs, encryption contexts, storage, queues and account passwords do not move.

Public GET/HEAD navigation on `.com`, including the homepage and invitation signup, redirects to the same path/query on `.org`. The Location header does not add a fragment, so browsers retain an existing invitation fragment. Redirects use temporary 307 responses with `Cache-Control: no-store` during the transition. The `www` aliases redirect to the primary origin; mutation requests there are refused rather than forwarding credentials or request bodies. Ordinary HTTP navigation upgrades to the corresponding trusted HTTPS destination.

The `.com` app, authentication/recovery pages, API, health checks, association document and static shell stay available for existing devices. They are a compatibility path, not a separate account system. Legacy account documents are marked `noindex`. Other `.com` subdomains are unchanged: staging, status pages, staff identity provider and temporary operator tools are not included in apex redirects.

API requests remain strictly same-origin. A legacy request receives its own environment copy with the legacy `APP_URL`; the shared bindings and scheduled jobs retain the canonical URL. The middleware does not add wildcard CORS, trust arbitrary Host/forwarded headers, rewrite user-supplied callback destinations, or redirect mutation bodies across origins. Malformed migration settings and unknown request origins fail closed. The renderer requires the explicit legacy origin until a separate retirement change is reviewed.

## Existing browsers and installed apps

Browser cookies, remembered encryption keys, device fingerprints, service workers and notification permissions belong to an origin. They cannot silently become `.org` state. Existing `.com` installations continue to work through the compatibility path; do not clear their data or uninstall them before confirming access on `.org`.

A member signs in with their existing account at `.org`, then uses their encryption recovery secret to unlock the encrypted backup and enroll that browser. A login-password reset does not recover content keys. The new site links back to `https://porchday.com/app` when someone needs their previous browser, and the old app explains the transition. The application does not automatically transfer keys between websites.

The `.org` PWA is a distinct installation and may need notification permission again. Both origins cache only the public application shell and assets. A dedicated extensionless `/app-shell` URL avoids precaching the now-redirecting legacy homepage; Cloudflare serves the generated `app-shell.html` file at that URL. Private API responses and decrypted content remain excluded from service-worker caches, and the existing update-consent/draft safeguards remain.

New native iOS builds use `.org` and accept supported post links from both exact owned production hosts. The bundle ID and Keychain service stay unchanged, retaining local encryption keys. Older builds keep using the compatible `.com` API. Cross-origin API redirects remain forbidden.

## Email, staff and monitoring

The verified sender remains `Porchday <accounts@porchday.com>`. Changing the email sender is a separate DNS and Email Sending verification task. Requests made on the canonical site generate `.org` action links; existing messages and actions initiated by legacy clients can retain `.com` links. The legacy origin continues to validate those callbacks without weakening the same-origin checks or one-use/replay protection.

The existing production Cloudflare Access application now protects the four exact destinations: `.org/staff`, `.org/api/staff`, `.com/staff` and `.com/api/staff`. Its application ID, audience, policies, MFA, session duration and unrelated cookie preferences were preserved. The guarded `scripts/provision-staff-access.py --migrate-production-domain` command performs the transition and verifies readback; completed state is checked without another update. Ordinary provisioning must not silently repair or repeat a partial migration.

The production monitor now probes `.org` directly and has reported a fresh operational check with metrics ready. It continues refusing redirects for capability-bearing requests. Status remains at [status.porchday.com](https://status.porchday.com), with staging at [staging.porchday.com](https://staging.porchday.com) and its monitor at [staging-status.porchday.com](https://staging-status.porchday.com). The old application health routes remain usable during the transition.

## Verified cutover and remaining device checks

The October 26 cutover used source `f37b9b6`, verified on staging before production. Production release verification completed at 23:13 UTC: both origins passed protected health with no issues, the executable and 30 embedded application sources matched the candidate, all 23 built assets were checked, and live policy, queues and enabled signup were preserved except for the declared production domain variables. The updated production monitor reported operational status and metrics ready at 23:15 UTC. These are dated migration checkpoints; later releases may supersede the application version without changing the domain policy.

Hosted desktop/mobile public-browser checks passed redirects, invitation-fragment retention, legacy account paths, service-worker installation on both origins, origin-isolated synthetic browser storage and the offline public shell. They made no hosted account writes and did not move a member's actual encryption keys. TLS validation remained enabled during a temporary public-DNS IPv4 override; the local resolver still returned unreachable IPv6 addresses during the normal-browser check. The override verifies the deployed service, not recovery of that machine’s DNS cache.

Existing-member sign-in, recovery-secret unlock and re-enrollment on `.org`, installed-PWA notification permissions and physical iOS Universal Links remain separate device acceptance. Keep `.com` compatibility until those needs are resolved; physical native checks are tracked in [issue #7](https://github.com/andyk/porchday/issues/7). Cloudflare's injected analytics script was blocked by the existing CSP during browser checks, with no external response or beacon submission observed; provider-side removal remains [issue #18](https://github.com/andyk/porchday/issues/18). Neither follow-up is claimed complete by the public cutover.

## Rollout procedure

The completed rollout followed this order; retain these checks for any later domain-policy change.

1. Add `porchday.org` to Cloudflare and change its registrar nameservers to the pair Cloudflare assigns. Confirm the zone is active and DNSSEC delegation is consistent; never guess the assigned nameservers.
2. Build one committed candidate, run CI and verify both origin behaviors in isolated tests. Preserve the live enabled-signup policy, all unrelated bindings/secrets, privacy settings, queues, placement and resource IDs.
3. Extend staff Access protection before exposing staff paths on `.org`. Add the production custom domains and wait for DNS/TLS readiness. Keep the working `.com` deployment until this is established.
4. Deploy and verify staging using its existing `.com` origin. Upload the production candidate inactive, compare its bindings/runtime to the intended settings, then activate it only if the live baseline still matches.
5. Check canonical and legacy protected health, served assets, public redirects with paths/query/fragments, old account/API routes, denied cross-origin mutations and both staff protections. Update the production monitor and confirm its new direct target is healthy.
6. Record exact versions and evidence in the issue and implementation record. Existing-device acceptance and any eventual retirement of legacy account routes are separate from public-navigation forwarding.

No database migration, password reset or rotation of existing content keys was required for the domain change. Do not disable signup, reset member credentials, delete browser keys, remove the legacy API, or recreate staff roles as a shortcut. Operator receipts and authentication test material remain private.
