# Security policy

Porchday has deployed development builds. No stable supported release or maintenance window is designated in this policy. Fixes target current development; old commits and the package version `0.1.0` are not supported release lines. See the [changelog](CHANGELOG.md) and [verification record](docs/build-status.md).

## Report a vulnerability privately

Do not put a suspected vulnerability in an ordinary issue, pull request, discussion or screenshot. These are not confidential reporting channels, even when a repository is private.

Use [GitHub private vulnerability reporting](https://github.com/porchday/porchday/security/advisories/new). Sign in to GitHub to submit a report, or open the repository's **Security → Advisories → Report a vulnerability** control. Reports go privately to repository maintainers through GitHub's advisory workflow; no separate email inbox is required.

Private reporting was enabled and its public entry point verified on October 27, 2026. Maintainer email delivery has not been independently verified; maintainers should watch security alerts and check the private advisory queue. [Publication issue #16](https://github.com/porchday/porchday/issues/16) records verification evidence. The reporting feature is a GitHub setting: maintainers should follow [GitHub's configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) when changing settings or notification preferences.

If the reporting control is absent or unavailable, existing collaborators can use their established private project contact to confirm a restricted channel. Share only the affected component and likely impact until the recipient and channel are confirmed. If you lack an existing private contact, do not guess an address or disclose exploit details in an ordinary issue. No staffed response time is promised.

## What to include

Once a private channel is confirmed, provide:

- Affected commit or build, platform, component and relevant configuration without credentials.
- Expected and observed behavior, likely impact, and prerequisites such as account role or relationship.
- A minimal reproduction using local or explicitly authorized test resources and synthetic accounts.
- Sanitized error details and whether the issue may already have exposed another person's data.
- Any proposed disclosure timing; use the private advisory conversation for follow-up when that route is available.

Do not send passwords, session tokens, private encryption keys, recovery secrets, member content or a production database dump. If you encounter another person's data, stop accessing it and report only the facts needed to locate the incident. This policy does not authorize testing other people's accounts or production infrastructure, and does not establish a bounty or legal safe-harbor program.

## Handling a report

The responsible maintainer should acknowledge the report when available, assess impact, restrict access, arrange an authorized reproduction and coordinate a fix with regression coverage. Authentication, encryption, audience checks, inherited expiry, deletion, restore safety and account takeover require particular care. Keep private data and exploit details out of ordinary issues and commits until an appropriate disclosure decision.

Coordinate disclosure timing with the reporter. When disclosure is appropriate, identify affected versions, mitigations and the fix. Do not publish a reporter's identity without permission. These are handling expectations, not a claim that a staffed response service exists.

## Security boundaries

Read the [encryption protocol and threat model](docs/crypto-protocol.md). Private social content is encrypted on member devices, but the service still processes authentication and routing metadata and explicitly disclosed reports. Encryption does not recall content already copied by an authorized recipient. Login recovery cannot recover missing content keys. The protocol does not provide forward secrecy or automatic post-compromise security, and browser-delivered code remains a trust boundary.

Independent application/cryptography review and the broader pilot admission requirements in [build status](docs/build-status.md) remain separate from source publication. Tests, deployment and a public license do not establish an audited or fully staffed service.
