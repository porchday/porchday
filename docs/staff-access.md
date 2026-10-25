# Staff Access provisioning and enrollment

Cloudflare Access protects the staff console and API before the application verifies a signed staff assertion. Access admission alone does not grant a Porchday staff role.

The staff entry at `/staff` does not require a social member account or an unlocked encryption vault. It reads `/api/staff/identity`, which verifies the actual signed Access assertion and returns only that person's subject, email and current roles. A person without a role sees a pending-role notice and their non-secret account reference for operator authorization; this endpoint never grants a role or reveals a session token. Recovery reviewers can then use their authorized queue directly. Reading disclosed moderation evidence remains an explicit separate step at `/staff/moderation`, requiring a social member account and trusted-device vault. Local browser guards cover this separation, clearing case details on access loss, ignoring a late case response and navigating the document to Access logout. Hosted assertion/MFA and role checks remain separate evidence requirements.

## Provisioned configuration

On 2026-10-25 the Cloudflare API accepted and a separate read-only pass verified:

- Organization name **Porchday**, team origin `https://porchday-staff.cloudflareaccess.com`.
- Independent MFA enabled globally with `security_key` and `biometrics`, a one-hour MFA session, and identity-provider AMR matching disabled.
- One email one-time PIN identity provider. Each staff application permits only that provider.
- One application per environment: `Porchday staff staging` covers `staging.porchday.com/staff` and `staging.porchday.com/api/staff`; `Porchday staff production` covers the corresponding paths on `porchday.com`. Each environment has a distinct audience shared by its two paths.
- Exactly one allow policy per application, restricted to the owner's exact private email and the OTP provider. No email-domain rule, public destination override, bypass policy, service-token admission or WARP authentication is configured.
- Independent MFA is also explicitly required by each application and policy, using the same two authenticator options and one-hour duration. Access application and policy sessions last one hour. Binding and HttpOnly cookies are enabled; the cookie covers the hostname so both staff paths work.

This is provider configuration verification, not proof of a completed staff login. After application deployment on 2026-10-25, unauthenticated requests to `/staff`, `/staff/`, `/api/staff`, `/api/staff/recovery` and `/api/staff/moderation` on both environments returned HTTP 302 to `porchday-staff.cloudflareaccess.com`, while `/health` returned 200. These checks used public DNS answers from 1.1.1.1 with the correct hostname/TLS SNI because the local resolver still had stale answers. At that initial checkpoint, signed login assertions were unverified. No personal authenticator was enrolled, no login email was requested and no database staff role was granted by Access provisioning. The later authorized role execution is recorded below.

Cloudflare documents independent MFA separately from an identity provider's MFA claims. Email OTP supplies the first step; the person must complete the required independent authenticator step. MFA settings at policy level override application and organization settings. The MFA session is checked at subsequent login; its expiration does not terminate an existing Access session, which is why the Access token session is also limited to one hour. See [independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/) and [MFA policy requirements](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/).

## Reproduce or verify

Use the local deployment credential, never a Worker runtime token:

```sh
python3 scripts/with-secrets.py python3 scripts/provision-staff-access.py
python3 scripts/with-secrets.py python3 scripts/provision-staff-access.py --check
```

The script reads the private owner email from `cloudflare_username` and never prints it. Optional exact reviewer emails are read from `STAFF_STAGING_RECOVERY_REVIEWER_EMAIL` and `STAFF_PRODUCTION_RECOVERY_REVIEWER_EMAIL`; an unset value means owner-only for that environment. These values belong only in the private operator secrets file, never a committed configuration. Output contains only the public issuer and resource IDs/audiences. Merge each environment's `staff_access_issuer` and `staff_access_audience` into `infra/resources.json`, then regenerate its Worker configuration with `scripts/configure-worker.py`. Application/policy/identity-provider IDs are inventory references, not bearer credentials. The script does not edit the manifest or secrets file.

Provisioning can resume after partial success without creating duplicate resources. It validates every existing policy/application before any write and refuses ambiguous resource names, unrelated applications, unexpected policy/path/MFA changes, and renaming a team with existing apps or users. It does not silently reconcile policy drift or expand an existing allowlist. `--check` makes only GET requests and fails if configuration is incomplete or differs from the privately configured roster. A different team name can be supplied with `--team` when initially provisioning; an unavailable name fails visibly instead of choosing an unreviewed replacement.

The API currently returns a disabled service-token inactivity placeholder with null fields that its PUT endpoint rejects. The script omits only that exact unset placeholder and preserves configured inactivity controls. It also handles Cloudflare's omission of optional false defaults in GET responses. Fixed errors omit provider bodies because they can contain the owner email. Bounded inventories that require pagination stop for review.

The first staged roster attempt stopped before mutation because the provider's policy GET representation contained an additional `uid` field. A separate read-only inspection confirmed that it exactly equals `id` on both policies. The tool accepts only that nonempty string alias, keeps it in preflight/postflight snapshots, and omits it from the PUT body because it is not a documented update field. A mismatched or malformed alias in either environment is rejected; other unknown fields still require review.

The subsequent authorized staging update wrote the policy, but its postflight comparison reported a change and did not claim success. Separate read-only checks on 2026-10-25 then confirmed the exact configured owner-plus-reviewer roster in staging, owner-only production, required OTP/MFA settings, and unchanged issuer, audience, identity-provider, application and policy IDs against the saved inventory. No update was retried. The comparison had missed that both the application list and application detail embed full copies of the policy: their include list and policy `updated_at` change with the same policy PUT. The comparison now accounts for those known representations of the exact staging policy, preserving checks on every other field, policy precedence, application and production configuration. A provider-shaped regression exercises this case and rejects unrelated embedded-policy drift. This verifies the roster configuration, not either person's completed MFA login or database role.

## Reviewed staging reviewer update

The bounded update supports one explicit transition: an existing owner-only **staging** policy to the owner plus one privately configured, distinct reviewer email. Production must remain owner-only; leave its reviewer variable unset. Adding an email does not enroll an authenticator, grant a database role, establish a distinct human identity, or approve a recovery case. The human nomination is operator authorization for this allowlist change; real signed identities and MFA are still required below.

After authorization, privately configure the exact staging reviewer, then run:

```sh
python3 scripts/with-secrets.py python3 scripts/provision-staff-access.py --update-roster staging
python3 scripts/with-secrets.py python3 scripts/provision-staff-access.py --check
```

Default provisioning and `--check` deliberately reject the old owner-only staging roster once a reviewer is configured. Only the explicit update can expand it. An already exact approved roster is idempotent and makes no writes. Keep the reviewer variable configured afterward so future checks preserve that roster. Production updates, replacing an existing reviewer, removing the owner, shared policies, unknown policy fields and additional selectors all require a separately reviewed change; this command refuses them.

Before writing, the tool verifies both applications, both policies, the OTP provider and organization MFA, then repeats the complete read-only snapshot. It sends at most one PUT to the existing staging policy, preserving its name, ID, OTP/MFA settings and every recognized writable field except the exact email include list. Neither application nor production is written. It rereads both environments and compares settings and public IDs after the PUT. Observed concurrent drift stops the operation; an uncertain write or postflight mismatch requires manual inspection, with no automatic retry or rollback. Cloudflare's documented [reusable-policy update](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/update/) does not expose an atomic conditional-write contract, so these checks cannot exclude an administrator changing configuration between the last read and PUT. Use an operator change window.

The in-memory provider tests cover exact/idempotent rosters, preflight refusal before writes, preserved production and optional policy settings, observed preflight/postflight races, and fixed errors/output without private email values. These tests are not evidence that the hosted roster has been changed or that either reviewer has completed login.

## App Launcher for MFA enrollment

Cloudflare's [App Launcher](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/app-launcher/) is disabled until it has a separate allow policy. The Launcher is [exempt from global independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/) so approved people can enroll their first authenticator. This exemption does not grant access to either staff application or remove their required MFA.

After the approved staging reviewer is privately configured and both staff rosters pass verification, the explicit bounded command is:

```sh
python3 scripts/with-secrets.py python3 scripts/provision-staff-access.py --enable-launcher
python3 scripts/with-secrets.py python3 scripts/provision-staff-access.py --check
```

It creates a dedicated reusable Launcher policy with exactly the owner and configured staging reviewer, requiring the existing email OTP provider. It then creates the `app_launcher` application with that policy already attached, the same OTP provider and a one-hour session. The [documented application create API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/) assigns the Launcher name/domain; this tool does not overwrite them or set staff-level independent MFA on the enrollment application. Production remains owner-only. No staff application, staff policy, organization setting, authenticator or database role is changed.

The command takes two complete read-only preflight snapshots, refuses observed drift, and verifies all prior protected configuration after the bounded creates. A pre-existing exact Launcher is idempotent. Unrelated or duplicate applications, extra policy selectors, shared Launcher policy, unexpected MFA settings and unverified roster changes are rejected. An ambiguous provider response or postflight mismatch requires manual inspection; never retry automatically. A verified unattached Launcher policy can be explicitly resumed without creating another policy. Provider write/readback does not prove that a person enrolled MFA or authenticated successfully.

Hosted configuration verified on 2026-10-25: the explicit create completed and its full postflight comparison passed. A separate read-only `--check` also passed. The Launcher has exactly the approved two-email OTP roster; staging remains two emails and production owner-only. Both staff applications, their policy IDs/audiences, OTP provider and organization/staff MFA settings were unchanged. No authenticators or database roles were created. The 26 focused in-memory provider tests passed; actual human enrollment/login remains a separate check.

After configuration, the approved people personally open [the Launcher](https://porchday-staff.cloudflareaccess.com) or [the authenticator enrollment page](https://porchday-staff.cloudflareaccess.com/AddMfaDevice). Use email OTP, then Account → MFA devices. Never enroll or retain their authenticator for them. An already enrolled authenticator is required when adding or removing later MFA devices.

## Staging recovery-role authorization

`provision-staff-role.ts` is an operator-only tool, separate from Access provisioning. It supports only `staging`, only the privately configured `owner` or `reviewer`, and only the `recovery` role. It is **read-only by default**. Do not use `--apply` until the operator has confirmed that the named person completed the real staff sign-in and approved their exact signed subject/email pair. Preparation and local tests do not grant hosted roles; the later authorized execution is recorded below.

After that confirmation, create an owner-only directory `artifacts/private/staff-access` (mode `0700`) and a reference JSON file (mode exactly `0600`). Use these six fields, populated from the actual verified `/staff` identity and the operator's confirmation:

```json
{
  "v": 1,
  "environment": "staging",
  "subject": "<actual Access account reference>",
  "email": "<actual configured email>",
  "confirmedAt": "<confirmation time in ISO 8601>",
  "source": "human-confirmed-signed-staff-identity"
}
```

The reference must be less than 24 hours old. Its source label records human-confirmed provenance; it is **not cryptographic proof**. Never put an assertion, JWT, cookie or one-time code in this file. Unknown fields, symlinks, public permissions, mismatched email or an invalid subject are rejected.

```sh
# Read-only preflight. Use owner.json/--identity owner for the owner.
python3 scripts/with-secrets.py npx tsx scripts/provision-staff-role.ts staging --identity reviewer --reference-file artifacts/private/staff-access/reviewer.json
# Only after explicit authorization of this exact confirmed identity:
python3 scripts/with-secrets.py npx tsx scripts/provision-staff-role.ts staging --identity reviewer --reference-file artifacts/private/staff-access/reviewer.json --apply
```

Both modes first bind the configured Cloudflare account and staging database to the saved inventory, verify current Access policy/MFA configuration and the saved OTP/Launcher/application IDs and audiences, then call Cloudflare's authenticated [get-user API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/users/methods/get/) for the exact subject and require its email to match the private configuration. Cloudflare documents the [application-token subject](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) as the user ID, unique to an email within the account. Directory membership/Access-seat status does not prove MFA or admission to the staff application. A recreated directory identity must not silently replace an earlier subject.

The database credential is the staging operator migration credential, with the `porchday-staging`/`main` metadata and branch checked against the saved staging inventory and TLS verified. No additional runtime permission is granted. Apply creates an exclusive private `.apply-receipt.jsonl` beside the reference **before** entering the transaction. The transaction locks the staff roster, rejects a same-email/different-subject or same-subject/different-email conflict, and refuses to reactivate an inactive row or change any existing role set. It creates only an active `recovery` row and `staff_recovery_role_provisioned` security-audit record atomically. The audit's staff subject is the affected identity; the protected receipt records the operator-confirmed source. An existing exact active recovery row is idempotent. Readback is checked inside and after the commit.

A failed or uncertain apply keeps the intent receipt and blocks blind reuse of that reference. Inspect the protected receipt and rerun **read-only** before deciding what happened; never delete a receipt to force a retry. Terminal output contains fixed status/identity-choice labels, not email, subject, database URLs, provider bodies or credentials. The human must then refresh `/staff` and verify the real recovery queue is accessible. Production, moderation, role replacement, deactivation/reactivation and account recovery decisions remain separate authorized operations.

The focused suite covers private-file/reference rules, exact directory and staging-branch checks, read-only defaults, identity and role conflicts, real PostgreSQL audit rollback, and concurrent duplicate submissions producing one grant/audit. Local database tests require `STAFF_ROLE_TEST_DATABASE_URL` pointing to a dedicated localhost database named `porchday_staff_role_test`; no hosted database is accepted for those tests.

### Hosted role execution, October 25, 2026

The operator reported both nominated people's MFA enrollment and supplied their labeled non-secret account references from the verified staff page. Each reference was stored privately and independently matched to the exact approved email through Cloudflare's authenticated directory. Both read-only preflights verified the configured Access applications, rosters, OTP and MFA settings and reported `would_create`. This records human-confirmed signed-page provenance plus directory/configuration verification; no JWT, cookie or authenticator was requested or retained.

The first owner apply failed inside the transaction because `fetch_types:false` makes this PostgreSQL driver return a raw `text[]` string, while strict role validation expected an array. Independent read-only verification at **21:12:39.718 UTC** found zero matching role rows and zero grant-audit rows, establishing rollback. The failed intent and readback remain private. Correction `9767c33` projects roles as JSON without weakening validation; all 13 focused checks passed, including seven real PostgreSQL tests using the CLI's actual driver setting. A new owner attempt preserved the original confirmation and failed receipt, passed read-only preflight, and succeeded. The reviewer's single apply then succeeded.

A separate read-only transaction at **21:14:58.418 UTC** verified exactly one active `recovery` role row and one grant-audit row for each approved identity. No production role, moderation permission, Access policy, authenticator, account hold or recovery decision was changed. The people must still refresh `/staff`, verify their recovery queue access, and personally perform the separate two-reviewer acceptance steps.

## Remaining enrollment and launch checks

Both nominated staging recovery roles are verified in the database. The people subsequently confirmed queue access, with matching post-grant queue-view audits independently observed. Each recorded one hold on the synthetic case; matching reviews/audits and saved-session revocation were verified at 22:18 UTC. Both then independently approved restoration. The 22:29 UTC read-only checkpoint verified two eligible approvals and one provider-accepted restoration email. Inbox receipt, claimant completion, restored login and encrypted-history recovery remain pending; see the [recovery acceptance record](hosted-recovery-verification.md). The steps below are also the procedure for future staff onboarding; completed provisioning does not substitute for ongoing staffing or full recovery acceptance.

1. Once each hostname is online, verify unauthenticated `/staff`, `/staff/`, `/api/staff`, `/api/staff/recovery` and `/api/staff/moderation` requests are protected by Access. Verify ordinary member routes remain accessible according to their own application authorization. Keep alternate Worker origins disabled and verify the application's assertion checks reject absent, forged or wrong-audience assertions.
2. The owner personally visits the [staff App Launcher](https://porchday-staff.cloudflareaccess.com), signs in with email OTP, and enrolls a security key or supported platform authenticator under Account → MFA devices. Do not create or retain an authenticator on someone's behalf. Test that the independent MFA prompt actually gates staff access. Enrollment and successful authentication are separate from the API configuration checks above.
3. Open `/staff` to obtain the account reference from the real signed Access `sub` and verified email through the signature-validated identity endpoint. Provision only that exact pair in `public.staff_users` with the explicitly approved `recovery` and/or `moderation` roles. Never invent a subject, trust an unsigned JWT decode, or use an email-only role lookup. Do not ask the person to paste session tokens, or put assertions, cookies or private email addresses in issue reports or committed artifacts.
4. Nominate and authorize a second recovery reviewer, add their exact staging email through the reviewed update above, have them enroll their own MFA and assign their verified subject separately. Production remains owner-only until separately authorized and reviewed. The initial owner-only allow policy is insufficient to operate the two-reviewer ownership-restoration workflow; a second email alone does not prove that two distinct authorized people have completed it.
5. Verify the console and both staff API families with authorized and unauthorized identities, record sanitized evidence, and define lost-authenticator/operator escalation. A Cloudflare account administrator controls Access policy recovery; do not create a public bypass or modify account ownership directly in the database.

These steps, reviewer staffing and actual denial/MFA/role checks remain admission gates. Cloudflare configuration does not prove that account recovery is staffed or operational.
