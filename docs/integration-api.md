# Porchday integration API v1

This is the consumer contract for the implemented pilot API, as of 2026-10-25. Deployment and public availability are separate from implementation; use the HTTPS origin supplied by the operator. The examples use `https://porchday.example`, a placeholder, and contain no live credentials.

The API lets a person authorize a tool to retrieve **their own ciphertext and routing metadata**. It does not return decryption keys, a friends feed, or other people's private contributions. There are no social-write scopes. Human-operated clients and member-authorized backup/migration tools are supported; autonomous AI member agents and automated social actions are not.

## Addresses and versioning

| Purpose | Address relative to the Porchday origin |
| --- | --- |
| Integration API v1 | `/api/integration/v1` |
| Browser consent page | `/app/integrations/authorize` |
| First-party client/grant management | `/api/v1/integrations` |

The earlier `/api/integration/token` and `/api/integration/own/...` routes remain compatibility aliases of the same v1 handlers, grants, and rate limits. New clients should use `/api/integration/v1/...`; changing aliases cannot reset a grant's limits. There is no version header or OAuth discovery endpoint. The encrypted object protocol has its own `v: 1` and `protocol: "porchday-openpgp-v1"` fields.

Use JSON over HTTPS and send access tokens only in the `Authorization` header. Responses are private and not cacheable. Cross-origin browser CORS access is not enabled; a third-party website needs a server-side exchange/read component, or a human-operated local/native client. Navigating a browser to the consent page works independently of CORS. Never collect a member's Porchday password, session cookie, device private key, or recovery secret.

## Register a client

In **My data → Register a tool you're building**, supply a name, purpose, and one exact return URL. Registration creates a public client ID, not a client secret. A client can request consent from other eligible members; registration alone grants no account access.

The first-party management request is:

```http
POST /api/v1/integrations/clients
Content-Type: application/json
Origin: https://porchday.example
```

```json
{
  "name": "My migration tool",
  "purpose": "Copy my encrypted contributions to local storage",
  "redirect_uri": "http://127.0.0.1:49321/callback"
}
```

This request requires the member's existing first-party session and returns `201 {"id":"<client UUID>"}`. Name length is 1–100 characters and purpose length is 1–500. Return URLs must use HTTPS, except HTTP on `127.0.0.1` with an explicit port for local tools. URL credentials and fragments are forbidden. `localhost`, wildcard URLs, custom schemes, and multiple registered return URLs are not supported. The exact registered string must be reused for consent and code exchange, including its path and query.

There is currently no client-edit or client-delete endpoint. Register a new client if the return URL changes; members revoke existing grants separately.

## Authorize with PKCE

Generate a fresh random verifier and state for each attempt. Keep them together in private, short-lived client state; neither belongs in logs. This Node.js example uses built-in cryptography:

```js
import { createHash, randomBytes } from 'node:crypto';

const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authorize = new URL('/app/integrations/authorize', porchdayOrigin);
authorize.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: registeredRedirectUri,
  scope: 'profile:read content:read media:read',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
}).toString();
// Save { verifier, state, clientId, registeredRedirectUri } privately,
// then open authorize.href in the member's browser.
```

Only `S256` is supported. The verifier must have 43–128 characters from `A-Z a-z 0-9 . _ ~ -`; the challenge is 43 base64url characters without padding. State must be 16–512 characters. Request one or more of the four scopes below, separated by spaces in the browser URL.

The member signs in and reviews the client name, purpose, return address, and requested scopes. Granting consent requires a session created within the preceding 15 minutes; the interface may ask the member to sign in again. An affirmative choice creates a grant and redirects to the registered URL with `code` and the original `state` query parameters. Cancel returns to My data; it does not issue an OAuth error redirect.

At the callback, compare state to the saved attempt **before** exchanging the code. Reject missing, mismatched, or already-consumed attempts. Remove callback query parameters from browser history/logging after handling them. The verifier never travels in the browser authorization URL. The code is single-use and expires after five minutes.

For clients implementing the first-party consent interface, its authenticated submission is `POST /api/v1/integrations/authorize` with:

```json
{
  "client_id": "00000000-0000-4000-8000-000000000001",
  "redirect_uri": "http://127.0.0.1:49321/callback",
  "scope": ["profile:read", "content:read"],
  "code_challenge": "replace-with-the-43-character-S256-challenge",
  "code_challenge_method": "S256",
  "state": "replace-with-the-saved-random-state",
  "consent": true
}
```

The values labeled `replace-with-...` above are explanatory placeholders, not valid cryptographic examples. The result is `{"redirect_uri":"<registered URL with code and state>","grant_id":"<UUID>"}`. A third-party client must use explicit member consent, not submit this endpoint using stolen or requested session cookies.

## Exchange and refresh tokens

Send JSON, or `application/x-www-form-urlencoded`, to:

```http
POST /api/integration/v1/token
Content-Type: application/json
```

```json
{
  "grant_type": "authorization_code",
  "client_id": "00000000-0000-4000-8000-000000000001",
  "redirect_uri": "http://127.0.0.1:49321/callback",
  "code": "<code from the validated callback>",
  "code_verifier": "<saved verifier>"
}
```

Success is HTTP 200:

```json
{
  "token_type": "Bearer",
  "access_token": "<43-character opaque token>",
  "refresh_token": "<43-character opaque token>",
  "scope": "profile:read content:read",
  "expires_in": 600
}
```

No client secret, session cookie, or `Origin` header is required for the token endpoint. It is a PKCE authorization-code/refresh flow, not OpenID Connect: there is no ID token, login profile, or identity-provider discovery response.

Access tokens last ten minutes. A grant expires 30 days after consent, and refresh does not extend that deadline. Access also stops at the grant deadline even if `expires_in` would extend beyond it. Refresh with:

```json
{
  "grant_type": "refresh_token",
  "client_id": "00000000-0000-4000-8000-000000000001",
  "refresh_token": "<latest refresh token>"
}
```

Refresh returns the same response shape and immediately replaces **both** tokens: the old access token and old refresh token stop working. Serialize refreshes and atomically replace the saved pair. A successful exchange whose response is lost may have consumed the old credential; obtain fresh member consent rather than retrying that credential indefinitely. Store tokens in protected application storage; do not put them in URLs, analytics, crash reports, screenshots, or command-line arguments.

## Read resources and scopes

All routes below use the v1 base address and require `Authorization: Bearer <access_token>`. Only the named scope authorizes its resource; `export:read` is not a substitute for the other scopes.

| Scope | GET route | Returned field and meaning |
| --- | --- | --- |
| `profile:read` | `/own/profile` | `profile`: the member's profile row, or `null` |
| `emoji:read` | `/own/emojis` | `emoji_library`: the owner-only encrypted collection row, or `null`; decrypt locally with the owner's keys |
| `content:read` | `/own/content?section=posts` | `posts`: authored posts; this is the default section |
| `content:read` | `/own/content?section=comments` | `comments`: authored comments/replies |
| `content:read` | `/own/content?section=post_reactions` | `post_reactions`: the member's reactions to posts |
| `content:read` | `/own/content?section=comment_reactions` | `comment_reactions`: the member's reactions to comments |
| `media:read` | `/own/media` | `media`: owned, uploaded photo metadata |
| `media:read` | `/own/media/:id/bytes` | Raw bytes of one owned encrypted photo envelope |
| `export:read` | `/own/exports` | `jobs`: the member's export-job metadata/status |

`export:read` does **not** create an export or download an archive. Use the first-party My data export workflow for portable archives; the separate [archive format](archive/README.md) describes those files. Bearer grants cannot call first-party export, import, social, key-directory, or encrypted-private-key-backup endpoints.

### Row fields

Rows contain database routing metadata and encrypted envelopes. Timestamps are strings; optional deadlines are `null`. Consumers should accept additive row fields without treating those fields as trusted decrypted content.

| Row | Useful fields |
| --- | --- |
| Profile | `member_id`, `handle`, `envelope` (possibly `null`), `updated_at` |
| Post | `id`, `author_id`, `group_id`, `audience`, `envelope`, `epoch`, `created_at`, `edited_at`, `expires_at`, `stored_at`, `import_source` |
| Comment | `id`, `post_id`, `parent_id`, `author_id`, `envelope`, `created_at`, `edited_at`, `expires_at`, `effective_expires_at`, `stored_at` |
| Reaction | `post_id` or `comment_id`, `member_id`, opaque `reaction_tag`, `envelope`, `created_at`, `effective_expires_at` |
| Media | `id`, `owner_id`, `post_id`, `profile_member_id`, `group_id`, `slot`, `envelope` routing metadata, `byte_size`, `state`, `display_order`, `created_at`, `envelope_sha256`, `raw_sha256`, `effective_expires_at` |
| Export job | `id`, `member_id`, `kind`, `state`, `schema_version`, `created_at`, `expires_at` |

A media state is `ready` or `attached`; pending uploads are excluded. Export-job history may contain expired, cancelled, invalidated, or failed jobs; a job row is not a download capability. Reaction tags do not reveal their emoji. Parent and recipient IDs are routing references, not permission to fetch another person's contribution. A member's own historical group contributions can be returned even after that member leaves the group; the group's other content is not included.

### Pagination

Every metadata response contains `next_cursor` and `snapshot_at`. Content pages also contain the four supported `sections`. For example, an empty posts page is:

```json
{
  "posts": [],
  "next_cursor": null,
  "snapshot_at": "2026-10-25T00:00:00.000Z",
  "sections": ["posts", "comments", "post_reactions", "comment_reactions"]
}
```

Follow `next_cursor` on the same resource and section until it is `null`; a short page alone is not the end. Use `URLSearchParams` to encode it. Cursors are opaque standard-base64 strings and can contain `+`, `/`, and `=`. Do not decode, construct, or reuse them across sections, grants, or accounts. They are not bearer credentials and never bypass a fresh authorization check.

Pages contain at most 25 records. A roughly 4 MiB serialized-row budget can shorten a page; the first row is allowed even if larger, and response wrapping adds bytes, so 4 MiB is not a hard HTTP-size guarantee. There is no caller-selected `limit`. Results use stable lexicographic identity ordering, **not** feed or creation-time ordering. Each content section needs its own first page/cursor chain.

The snapshot timestamp bounds newly inserted items; it is not an immutable multi-request database snapshot. Later edits can be observed, and deletion/expiry is rechecked on every page. The profile is current. These reads do not provide the first-party export workflow's final revision validation. An integration page has no top-level `schema_version` and does not add an `export_id` to each row.

This example assumes a valid access token and intentionally leaves credential refresh/retry decisions to the caller:

```js
async function* readPosts(porchdayOrigin, accessToken) {
  let cursor = null;
  do {
    const url = new URL('/api/integration/v1/own/content', porchdayOrigin);
    url.searchParams.set('section', 'posts');
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // Do not log the request, token, body, or callback URL.
      const error = new Error(`Porchday integration HTTP ${response.status}`);
      error.retryAfter = response.headers.get('Retry-After');
      throw error;
    }
    const page = await response.json();
    for (const post of page.posts) yield post;
    cursor = page.next_cursor;
  } while (cursor !== null);
}
```

### Media bytes and encryption

The photo bytes endpoint returns `application/octet-stream`. Its body is UTF-8 JSON for a complete encrypted object, not a JPEG. `byte_size` is the raw response size, at most 22,020,096 bytes. The media metadata page omits storage object keys and the ciphertext field from its routing envelope; retrieve the complete envelope through the bytes endpoint.

When present, `raw_sha256` binds the exact response bytes; `envelope_sha256` binds the canonical encrypted envelope. These are different digests and may differ even for valid JSON encodings. An absent digest is not successful verification. Metadata hashes do not replace signature, author-key, recipient, context, revision, or expiry validation.

Use the [encrypted content protocol](crypto-protocol.md) and [crypto package API](crypto-api.md) for those rules. Full post/comment/reaction/profile envelopes use `v`, `protocol`, `context`, `recipients`, and `ciphertext`. The signed inner binding must match the outer binding and the requested resource. Unknown signed binding fields must fail closed; the additive row-field rule above does not relax the cryptographic schema.

API consent supplies neither private keys nor the public-key directory needed to establish signer trust. A tool cannot become a trusted decryption device merely by obtaining a bearer token. Readable migration is available through a member's first-party export, or through separately reviewed local processing on an already trusted client with explicit member disclosure. Never ask for the account recovery secret or send an unlocked key to a third-party service.

## Expiration, revocation, and account state

Reads enforce grant/token lifetime, ownership, scope, and account state. Posts, comments, reactions, and photos also enforce their current content deadlines; export-job history can still show an expired job. Comment/reaction/media responses include effective deadlines where their parent can expire earlier. Media downloads check the photo's own and parent deadlines before accessing object storage; delayed physical cleanup does not extend access. Clients should also stop displaying cached content at its effective deadline.

Active and restricted accounts can authorize/read their own data. Suspended, held, deleting, or deleted accounts cannot use integration grants. The first-party suspended-account export exception does not apply to this API. Security holds and account deletion revoke grants; normal sign-out alone does not.

Members manage grants in **My data**. First-party management endpoints require their session and the same-origin `Origin` header on writes:

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/integrations` | Returns `clients` registered by this member and their `grants`, with app name/purpose, scopes, grant expiry, revocation and last-use timestamps |
| `GET /api/v1/integrations/clients/:id` | Returns client name, purpose, and registered return URL for the consent screen |
| `DELETE /api/v1/integrations/:grantId` | Revokes the member's grant and clears its credentials; returns `{"ok":true}` |

The deletion identifier is a **grant ID**, not a client ID. There is no bearer-token revocation endpoint. `last_used_at` changes on code exchange, refresh, and metadata-page reads; individual photo-byte downloads currently do not update it. Management collections are not paginated in this pilot.

Revocation takes effect for subsequent authorization checks, including both URL aliases. It cannot recall bytes already delivered to another service or erase that service's independent copies. A transport tool must explain its retention/deletion behavior to the member.

## Limits, errors, and retries

Limits use fixed UTC-minute windows and are shared by all tokens/aliases for a grant:

| Operation | Limit |
| --- | --- |
| Metadata pages and photo-byte reads, combined | 120 requests/minute/grant |
| Authorization-code exchanges and refreshes, combined | 10 attempts/minute/grant |

Attempts using an otherwise live credential count even if a later PKCE, scope, cursor, or resource check fails. Successful refresh does not reset the grant's counters. Invalid, expired, replayed, or revoked credentials return the generic authorization error rather than revealing a counter. A throttled exchange does not consume its code/refresh credential. These per-grant limits complement deployment edge controls; they are not a global anonymous/IP flood limiter. First-party registration and consent also share the ordinary member social-write limit (120 POST/PUT/PATCH requests per minute), which can be consumed by other first-party actions.

Bearer rate-limit responses have HTTP 429, a `Retry-After` integer of 1–60 seconds, and:

```json
{
  "error": {
    "code": "RATE_LIMIT",
    "message": "Wait before making another integration request."
  }
}
```

| HTTP/code | Meaning and client action |
| --- | --- |
| `400 INVALID_INTEGRATION_REQUEST` | Invalid first-party registration/consent input; check fields and exact return URL |
| `401 INVALID_GRANT` | Generic bearer/token failure: malformed input, missing scope, unavailable resource, expired/revoked credential, or unavailable account; the router also maps internal failures to this response, so it is not proof that a token merely expired |
| `401 UNAUTHORIZED` | A first-party management request needs a member session |
| `403 RECENT_AUTH_REQUIRED` | Sign in again before granting consent |
| `403 ACCOUNT_UNAVAILABLE` / `ORIGIN_DENIED` | First-party account/session or origin policy failed |
| `404 NOT_FOUND` | No integration operation exists at that path/method |
| `413 TOO_LARGE` | Request body exceeds the application limit |
| `429 RATE_LIMIT` | Wait for `Retry-After` on bearer requests; first-party rate-limit responses may omit it |
| `503` | Service/privacy-checkpoint availability gate; retain local state and retry with bounded backoff |

Error bodies use `{"error":{"code":"...","message":"..."}}`; some global errors omit `message`. Read the status/code rather than parsing human text. A missing or forbidden media object returns the same generic 401, not an existence-revealing distinction. A route-like unsupported resource can also yield 401; 404 is not universal for every unsupported spelling. There is no `WWW-Authenticate` challenge or OAuth-standard `error_description` contract.

Honor `Retry-After`, use bounded jitter/backoff for availability failures, and keep download concurrency modest. Do not automatically retry a potentially consumed code/refresh exchange after an ambiguous network result. Do not loop through refresh/consent on every 401. Process pages incrementally rather than retaining an entire account's ciphertext in memory.

## Contract verification

The implementation lives in `apps/api/src/social-integrations.ts`, mounted by `apps/api/src/index.ts`. SQL migrations 006, 012, 023, 026, and 038 define client visibility, token rotation, owned-data pagination, resource expiry, and limits. `apps/api/test/social.http.test.ts` exercises the actual Hono handlers and restricted PostgreSQL role with real encrypted content, including PKCE/scope/revocation, both route versions, refresh rotation, failed-attempt persistence, concurrent throttling, and expired-media denial before a storage read. Those checks establish local implementation behavior; they do not claim that a public endpoint is deployed or that a third-party integration has completed a live pilot.
