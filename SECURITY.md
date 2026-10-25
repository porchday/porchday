# Security policy

Porchday is an unreleased project in a private repository. No stable release or supported-version maintenance window has been announced. Security fixes currently target the development branch; old commits and development package version numbers are not supported releases. See [CHANGELOG.md](CHANGELOG.md) and the [implementation record](docs/build-status.md).

## Report privately

Do not disclose a suspected vulnerability in an ordinary issue, pull request, public discussion or screenshot. Repository issues are visible to every collaborator with the relevant access, even while the repository is private.

Current collaborators who already have an established private project contact with the repository owner, [@bobbyhwilder](https://github.com/bobbyhwilder), should use that contact to request a restricted security-reporting channel. Start with a short description of the affected component and impact; share reproduction details only after the recipient and channel are confirmed. The profile link identifies the owner and is **not** a GitHub private-message endpoint.

There is currently **no dedicated public security inbox or independently verified private reporting endpoint documented for Porchday**. If you do not already have a private contact, this file does not provide a working substitute. Do not guess an email address or send vulnerability details to a general-purpose public channel.

This is a launch gate: before admitting real members or publishing the repository, the owner must appoint a security-reporting contact and backup, establish a restricted channel, test delivery and access, and replace this limitation with usable reporting instructions. No staffed response time, bounty or legal safe-harbor program is promised by this policy.

## GitHub reporting after publication

[GitHub private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) is available for public repositories and must be explicitly enabled by an owner or administrator. It is not a functioning reporting channel for this currently private repository.

If the owner later authorizes public source release, enable that feature, verify the repository's **Report a vulnerability** control, configure notifications for the responsible people, and test the workflow before listing it as available here. Alternatively, publish another tested restricted reporting channel. Changing repository visibility is a separate decision and is not authorized by this document.

## Helpful report contents

Once a private channel is confirmed, include:

- Affected commit or build, client/platform, component and relevant configuration without credentials.
- Expected versus observed behavior, impact, and prerequisites such as account role or relationship.
- A minimal reproduction using local or explicitly authorized test resources and synthetic accounts/data.
- Relevant sanitized error details, and whether the finding may already have exposed someone else's data.
- A way to contact you privately and any disclosure timing you propose.

Do not send passwords, session tokens, private encryption keys, recovery secrets, unredacted member data or a production database dump. If accidental exposure occurred, stop accessing the affected data and report the minimum facts needed to locate the incident. Use local reproductions where possible; this policy does not authorize testing other people's accounts or production infrastructure.

## Handling and disclosure

The designated maintainer should confirm receipt when available, assess impact, restrict access to the report, agree on a safe reproduction, and coordinate a fix and regression tests. Treat authentication, encryption, audience authorization, inherited expiry, deletion, restore safety and account takeover as security-sensitive areas. Keep exploit details and private data out of normal commits until an appropriate disclosure decision is made.

Coordinate disclosure timing with the reporter and record the affected versions, mitigation and fix once disclosure is appropriate. Do not publish a reporter's identity without their permission. These are handling expectations, not a claim that a staffed response service already exists.

The [encryption protocol and threat model](docs/crypto-protocol.md) describe what the service can observe and the limits of client-delivered encryption. Independent security/cryptography review and the admission gates in [docs/build-status.md](docs/build-status.md) remain required; tests and this policy do not establish that the application is ready for real members.
