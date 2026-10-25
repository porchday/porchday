# Staff Access provisioning and enrollment

Cloudflare Access protects the staff console and API before the application verifies a signed staff assertion. Access admission alone does not grant a Porchday staff role.

## Provisioned configuration

On 2026-10-25 the Cloudflare API accepted and a separate read-only pass verified:

- Organization name **Porchday**, team origin `https://porchday-staff.cloudflareaccess.com`.
- Independent MFA enabled globally with `security_key` and `biometrics`, a one-hour MFA session, and identity-provider AMR matching disabled.
- One email one-time PIN identity provider. Each staff application permits only that provider.
- One application per environment: `Porchday staff staging` covers `staging.porchday.com/staff` and `staging.porchday.com/api/staff`; `Porchday staff production` covers the corresponding paths on `porchday.com`. Each environment has a distinct audience shared by its two paths.
- Exactly one allow policy per application, restricted to the owner's exact private email and the OTP provider. No email-domain rule, public destination override, bypass policy, service-token admission or WARP authentication is configured.
- Independent MFA is also explicitly required by each application and policy, using the same two authenticator options and one-hour duration. Access application and policy sessions last one hour. Binding and HttpOnly cookies are enabled; the cookie covers the hostname so both staff paths work.

This is provider configuration verification, not proof of a completed staff login. At this checkpoint the two application hostnames did not yet resolve in the local resolver, so edge redirects and signed login assertions remained unverified. No personal authenticator was enrolled, no login email was requested and no database staff role was granted by provisioning.

Cloudflare documents independent MFA separately from an identity provider's MFA claims. Email OTP supplies the first step; the person must complete the required independent authenticator step. MFA settings at policy level override application and organization settings. The MFA session is checked at subsequent login; its expiration does not terminate an existing Access session, which is why the Access token session is also limited to one hour. See [independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/) and [MFA policy requirements](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/).

## Reproduce or verify

Use the local deployment credential, never a Worker runtime token:

```sh
python3 scripts/with-secrets.py python3 scripts/provision-staff-access.py
python3 scripts/with-secrets.py python3 scripts/provision-staff-access.py --check
```

The script reads the private owner email from `cloudflare_username` and never prints it. Output contains only the public issuer and resource IDs/audiences. Merge each environment's `staff_access_issuer` and `staff_access_audience` into `infra/resources.json`, then regenerate its Worker configuration with `scripts/configure-worker.py`. Application/policy/identity-provider IDs are inventory references, not bearer credentials. The script does not edit the manifest or secrets file.

Provisioning can resume after partial success without creating duplicate resources. It refuses ambiguous resource names, unrelated applications, unexpected policy/path/MFA changes, and renaming a team with existing apps or users. It does not silently reconcile policy drift or expand the owner allowlist. `--check` makes only GET requests and fails if configuration is incomplete. A different team name can be supplied with `--team` when initially provisioning; an unavailable name fails visibly instead of choosing an unreviewed replacement.

The API currently returns a disabled service-token inactivity placeholder with null fields that its PUT endpoint rejects. The script omits only that exact unset placeholder and preserves configured inactivity controls. It also handles Cloudflare's omission of optional false defaults in GET responses. Fixed errors omit provider bodies because they can contain the owner email. Bounded inventories that require pagination stop for review.

## Remaining enrollment and launch checks

1. Once each hostname is online, verify unauthenticated `/staff`, `/staff/`, `/api/staff`, `/api/staff/recovery` and `/api/staff/moderation` requests are protected by Access. Verify ordinary member routes remain accessible according to their own application authorization. Keep alternate Worker origins disabled and verify the application's assertion checks reject absent, forged or wrong-audience assertions.
2. The owner personally visits the [staff App Launcher](https://porchday-staff.cloudflareaccess.com), signs in with email OTP, and enrolls a security key or supported platform authenticator under Account → MFA devices. Do not create or retain an authenticator on someone's behalf. Test that the independent MFA prompt actually gates staff access. Enrollment and successful authentication are separate from the API configuration checks above.
3. Obtain the real signed Access `sub` and verified email through an authenticated, signature-validated session. Provision only that exact pair in `public.staff_users` with the explicitly approved `recovery` and/or `moderation` roles. Never invent a subject, trust an unsigned JWT decode, or use an email-only role lookup. Do not put assertions, cookies or private email addresses in issue reports or committed artifacts.
4. Identify and authorize a second distinct recovery reviewer, add their exact identity through a reviewed policy change, have them enroll their own MFA and assign their verified subject separately. The initial owner-only allow policy is insufficient to operate the two-reviewer ownership-restoration workflow. Updating the authorized roster requires updating this deliberately owner-only provisioning tool so later checks preserve the approved policy.
5. Verify the console and both staff API families with authorized and unauthorized identities, record sanitized evidence, and define lost-authenticator/operator escalation. A Cloudflare account administrator controls Access policy recovery; do not create a public bypass or modify account ownership directly in the database.

These steps, reviewer staffing and actual denial/MFA/role checks remain admission gates. Cloudflare configuration does not prove that account recovery is staffed or operational.
