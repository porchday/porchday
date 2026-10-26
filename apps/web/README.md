# Porchday web client

React and TypeScript provide the public site and installable PWA. Vite builds static assets served by the Cloudflare application. The API is same-origin at `/api/auth`, `/api/v1`, `/api/account-recovery`, and role-protected `/api/staff`.

## Local setup

Run commands from the repository root with Node 24, npm, Python 3 and Docker installed. No hosted account or credentials are required. Install dependencies with `npm ci`.

For frontend-only work, `npm run dev` serves [localhost:5173](http://localhost:5173). Authenticated pages also need the API and database below. `npm run build` builds production web assets in `apps/web/dist`; a static server alone does not provide the API.

### Disposable development database

The development API currently expects PostgreSQL on **port 54329**. Use a dedicated disposable instance; do not reuse a database with real data. If that port is occupied, stop here and identify its owner rather than modifying the existing instance.

```sh
docker run --rm -d --name porchday-dev-postgres \
  -p 127.0.0.1:54329:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=porchday postgres:17

docker exec porchday-dev-postgres pg_isready -U postgres
```

Wait for `accepting connections` before applying migrations:

```sh
PG_LOCAL=true \
DATABASE_MIGRATION_URL='postgres://postgres@127.0.0.1:54329/porchday' \
node scripts/migrate.ts
```

This passwordless trust configuration is for the loopback-only disposable container. It is not a hosted database configuration. `PG_LOCAL=true` selects the local non-TLS connection; migrations require the container's owner role. The dev API installs synthetic local passwords on its three runtime roles when it starts.

In separate terminals at the repository root:

```sh
npm run dev:api
```

```sh
npm run dev
```

Open **http://localhost:5173**, which matches the API's configured origin. Vite proxies API requests to `127.0.0.1:8787`.

### Create a local account

Local signup still requires an invitation and email verification. Create a synthetic invitation with an explicit local destination:

```sh
PG_LOCAL=true \
DATABASE_MIGRATION_URL='postgres://postgres@127.0.0.1:54329/porchday' \
APP_URL='http://localhost:5173' \
node scripts/invite.ts developer@example.test
```

The command prints the path of an owner-only invitation file under `~/.config/inner-circle/invitations`. Open its link in your browser, use the same synthetic email address, and complete signup. Choose a local test password; do not reuse an actual account password. The password-breach check can require outbound access to the Pwned Passwords service.

The dev API captures outgoing mail as private `email-*.json` files in ignored `artifacts/private/dev`; it sends no real mail. Open the latest verification link from the local capture, then sign in and complete encryption-key setup. Keep invitation, verification and recovery material private even in local testing.

The Node adapter stores encrypted media in the same private directory. Its jobs sender is a no-op, and `ENVIRONMENT=development` deliberately permits running without the independent privacy journal. This setup does **not** exercise scheduled deletion, queue retries, Cloudflare Access, hosted delivery, backups or restore safety. `apps/api/wrangler.local.jsonc` is a separate local Worker verification configuration, not a drop-in production deployment or this Node setup; see [operations](../../docs/operations.md).

Stop both dev processes with Ctrl-C when finished, then remove only your disposable database with `docker stop porchday-dev-postgres`. With `--rm` and no volume, its data is discarded. Private mail/media captures remain under `artifacts/private/dev` until you remove your own local test files.

## Tests and reproducibility

For frontend tests and static checks, from the root:

```sh
npx vitest run apps/web/test
npm run typecheck
npm run build
python3 scripts/check-format.py
```

`npm test` also runs crypto and API/script tests. PostgreSQL suites skip without their environment variables. To exercise them, use a **separate disposable test database**; tests reset synthetic schemas and must not target the development database or hosted data.

```sh
docker run --rm -d --name porchday-test-postgres \
  -p 127.0.0.1:54330:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=porchday postgres:17

docker exec porchday-test-postgres pg_isready -U postgres
```

Once it reports `accepting connections`, run this subshell. Every URL is explicitly local, and the environment changes end with the subshell:

```sh
(
  export PG_LOCAL=true
  export TEST_DATABASE_URL='postgres://postgres@127.0.0.1:54330/porchday'
  export DATABASE_MIGRATION_URL="$TEST_DATABASE_URL"
  export MODERATION_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:54330/porchday_moderation_test'
  export SOCIAL_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:54330/porchday_social_test'
  export SOCIAL_HTTP_DATABASE_URL='postgres://postgres@127.0.0.1:54330/porchday_http_test'
  export PUSH_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:54330/porchday_push_test'
  export NATIVE_PUSH_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:54330/porchday_native_push_test'
  export JOURNAL_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:54330/porchday_journal_test'
  export AUTH_JOURNAL_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:54330/porchday_auth_journal_test'
  export STAFF_ROLE_TEST_DATABASE_URL='postgres://postgres@127.0.0.1:54330/porchday_staff_role_test'
  node scripts/migrate.ts &&
  node scripts/prepare-test-databases.ts &&
  npm test
)
```

Afterward, `docker stop porchday-test-postgres` discards that test instance. The equivalent automated setup is in [CI](../../.github/workflows/ci.yml). Package installation and container image retrieval need network access; the local SQL suites use synthetic identities and mocked external services.

Frontend tests cover expiry/audiences, reactions and custom PNG validation, profile state, PWA privacy, portability, consent and author-only resharing. They supplement server authorization and shared cryptography tests. Browser-intercepted synthetic tests, actual hosted-account tests, inbox confirmation and independent accessibility/security review are distinct evidence; see [build status](../../docs/build-status.md) and the [hosted checklist](../../docs/hosted-verification.md).

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Public site and product preview. |
| `/join`, `/login`, `/verify`, `/forgot`, `/reset` | Invitations, verification, email/password sign-in/reset and MFA challenges. |
| `/stolen-account`, `/recovery` | Stolen-account reporting, safe-contact verification and reviewed restoration. |
| `/app` | Chronological Home and encrypted composer. |
| `/app/wall/:member?`, `/app/post/:id` | Personal wall and post conversation. |
| `/app/connections`, `/app/groups`, `/app/groups/:id` | Mutual connections, invitations and private named groups. |
| `/app/notifications` | Access-checked notifications. |
| `/app/settings/profile`, `/app/settings/privacy`, `/app/settings/security`, `/app/settings/data` | Profile, preferences, account/keys and data controls. |
| `/app/integrations/authorize` | Explicit PKCE integration consent. |
| `/appeals` | Moderation review without decrypting private content. |
| `/staff` | Cloudflare Access and application-role-protected human review. |

## Privacy boundaries

Private social content is signed and encrypted through `@porchday/crypto` before upload. Login passwords and the encryption recovery secret serve separate purposes. A recovery signing identity authorizes new device keys; backups contain encrypted private-key armor. Remembering keys on a private browser requires opt-in. Sign-out clears remembered keys and revokes the browser's push subscription. Account and access metadata remain visible to the service; see the [protocol](../../docs/crypto-protocol.md).

The service worker caches application assets only, including offline manifest fallback. It does not intercept API requests, store decrypted content, or read push payloads. Push uses fixed generic text. Vite versions the shell cache and install-icon URLs; a waiting update requires an explicit action and checks for active drafts.

Post/comment audiences come from fresh server snapshots; missing recipient keys stop publication. Reactions validate their encrypted descriptor and per-target/member tag. Unicode metadata is pinned; custom images and saved personal emoji libraries are encrypted. Viewers can save a visible custom reaction to their own library. Absolute deadlines hide expired content, and replies show their inherited deadline before submission.

Ordinary edits do not broaden historical audiences. **Share this memory again** is an explicit author-only copy for a selected current audience, with fresh ciphertext/media and no copied comments or reactions. It retains or shortens the original absolute expiry. Later deletion or shortening of the source does not alter the independent copy; the confirmation explains this.

Profile/group edits re-encrypt retained pictures for current recipients; existing immutable posts stay unchanged. Profile visibility can be private or shared with current connections, while exact-lookup handles remain public. Browser-wide Autumn/Clean/generated backgrounds are device-local appearance preferences, separate from encrypted member profile themes.

## Data portability

Exports decrypt locally, check revisions/deadlines, and produce bounded multipart ZIP archives. Downloads encrypt each ZIP with a separate archive secret by default; readable ZIPs require explicit selection. Imports require all parts and the completion marker, validate paths/expansion limits/checksums, and show a preview before writing. User-saved exports cannot be recalled when content expires.

Imported own comments/reactions become private journal entries with context references. Other people's threads are not recreated. Connections and memberships are references, never automatically recreated relationships. The optional personal emoji library preserves its validated custom-image identities. Suspended members retain read-only vault unlock, owned export, deletion and appeals. Account deletion remains available from a locked vault without encryption keys. See the [archive contract](../../docs/archive/README.md).
