# Prepared hosted integration acceptance

This runner is prepared for operator review; it has **not been executed against staging**. It uses synthetic member A and the existing private Chromium test profile, sequentially after the archive check. It never attaches to the user's browser, reads SQL tokens, uses B/C, registers another encryption device, or changes social content. The integration client is local; no public hosting or publication is required.

After explicit operator approval and a quiet fixture window, the bounded invocation is:

```sh
node --import tsx scripts/hosted-integration-client.ts --run --attempt=<eight-new-hex-characters>
```

The operator must inspect an interrupted attempt before choosing another identifier. Exclusive private intent creation occurs before login or any remote mutation. Private receipts capture the created client and grant IDs, including discovery by the attempt's unique name and exact callback if a response is lost. Logs contain fixed phase/error labels, aggregate row counts and cleanup flags, never credentials, callback URLs, content, raw browser errors or provider responses.

The browser performs ordinary email/password login and unlocks A's existing device through the normal UI. Its device/profile baseline must remain unchanged. A request gate rejects unexpected browser mutations before forwarding allowed requests unchanged; service workers are blocked for this test so they cannot bypass that gate. This test makes no PWA/offline claim. The first-party test harness supplies synthetic credentials only to Porchday's own UI; the separate external HTTP client sends neither session cookies nor encryption keys.

The UI registers one public client, using `http://127.0.0.1:<ephemeral-port>/callback`, which the existing API explicitly allows. The receiver binds only IPv4 loopback, checks the exact Host/path, state, code shape and single-use attempt, rejects duplicate query parameters, and redirects to a clean completion URL with no-store/no-referrer headers. PKCE verifier and access/refresh tokens stay in process memory. No callback query or credential is intentionally written to receipts, logs, traces or screenshots. The normal browser redirect necessarily carries the one-use code and state; clearing the displayed URL does not prove their absence from all internal browser navigation metadata. The isolated profile remains private, the code is consumed, and the grant is revoked.

The test cancels the first consent screen and verifies no grant was created, then affirmatively consents to only `profile:read content:read`. It verifies rejection of an incorrect PKCE verifier, successful code exchange, rejection of code replay, bounded reads of A's profile/posts/comments/reactions, ownership and ciphertext envelopes, rejection of ungranted media/export reads, and rejection of bearer-only calls to first-party feed/key/device routes. It performs one refresh, checks both superseded credentials fail, revokes the grant through My data, then checks the current access and refresh credentials also fail. There is no decryption or private-key handoff to the integration.

Limits are four pages per content section, 25 rows per page, and 12 MiB per response. These are conservative synthetic-test bounds, not product limits. API denials must be the expected HTTP status and are not logged verbatim. The listener, browser and all memory-only tokens are discarded on completion. Normal same-origin signout, saved-session replay, local key clearing and browser-cookie clearing conclude the run.

Failure cleanup waits for tracked mutations, discovers only this attempt's exact client/grant, and uses normal member revocation endpoints for those captured IDs. No existing grant is revoked. **The current product has no client-delete endpoint:** a nonsecret registered client row remains even after successful grant cleanup; the callback port is closed and all grants are revoked. This limitation is explicitly reported in receipts/results, not hidden behind SQL cleanup or a test-only endpoint. A future client-management feature is separate scope.

Local tests exercise the actual loopback listener's hostile-state/Host/replay rejection, mutation boundaries, ownership/secret checks, token scope validation and invocation gate. They do not establish hosted consent, callback navigation, token issuance or revocation behavior. Those claims require the separately approved hosted run.
