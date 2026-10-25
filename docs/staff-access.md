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

This is provider configuration verification, not proof of a completed staff login. After application deployment on 2026-10-25, unauthenticated requests to `/staff`, `/staff/`, `/api/staff`, `/api/staff/recovery` and `/api/staff/moderation` on both environments returned HTTP 302 to `porchday-staff.cloudflareaccess.com`, while `/health` returned 200. These checks used public DNS answers from 1.1.1.1 with the correct hostname/TLS SNI because the local resolver still had stale answers. Signed login assertions remain unverified. No personal authenticator was enrolled, no login email was requested and no database staff role was granted by provisioning.

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

## Remaining enrollment and launch checks

1. Once each hostname is online, verify unauthenticated `/staff`, `/staff/`, `/api/staff`, `/api/staff/recovery` and `/api/staff/moderation` requests are protected by Access. Verify ordinary member routes remain accessible according to their own application authorization. Keep alternate Worker origins disabled and verify the application's assertion checks reject absent, forged or wrong-audience assertions.
2. The owner personally visits the [staff App Launcher](https://porchday-staff.cloudflareaccess.com), signs in with email OTP, and enrolls a security key or supported platform authenticator under Account → MFA devices. Do not create or retain an authenticator on someone's behalf. Test that the independent MFA prompt actually gates staff access. Enrollment and successful authentication are separate from the API configuration checks above.
3. Open `/staff` to obtain the account reference from the real signed Access `sub` and verified email through the signature-validated identity endpoint. Provision only that exact pair in `public.staff_users` with the explicitly approved `recovery` and/or `moderation` roles. Never invent a subject, trust an unsigned JWT decode, or use an email-only role lookup. Do not ask the person to paste session tokens, or put assertions, cookies or private email addresses in issue reports or committed artifacts.
4. Nominate and authorize a second recovery reviewer, add their exact staging email through the reviewed update above, have them enroll their own MFA and assign their verified subject separately. Production remains owner-only until separately authorized and reviewed. The initial owner-only allow policy is insufficient to operate the two-reviewer ownership-restoration workflow; a second email alone does not prove that two distinct authorized people have completed it.
5. Verify the console and both staff API families with authorized and unauthorized identities, record sanitized evidence, and define lost-authenticator/operator escalation. A Cloudflare account administrator controls Access policy recovery; do not create a public bypass or modify account ownership directly in the database.

These steps, reviewer staffing and actual denial/MFA/role checks remain admission gates. Cloudflare configuration does not prove that account recovery is staffed or operational.
