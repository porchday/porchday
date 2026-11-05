# Authenticated browser continuity during a feature release

On October 29, staging completed a guarded prior-UI to invitation-UI transition
with an already-open signed-in browser. [Evidence](authenticated-feature-rollout-2026-10-29.json)
pins runtime, assets, outcomes and limitations. Production was unchanged.

The old page completed normal login and recovery unlock, decrypted the synthetic
group name and description, and held an unsent exact-handle form. Thirteen
continuity samples verified its document identity, visible group and unchanged
form alongside allowed-session reads, revoked-cookie rejection and protected
readiness. All samples passed, including two after activation completed.

After activation, the old page made an authenticated profile read and imported
its previously cold lazy module. Retained module bytes matched the old manifest.
A new page in the same browser context loaded the exact new document, decrypted
the group, selected a connection, submitted one invitation, and displayed the
recipient and inviter in the owner roster. The old document and form remained
intact alongside the working new page. Recipient acceptance and non-owner access
checks passed. Every synthetic session was revoked and all fixture rows removed.

Before the forward release, a guarded switch to the prior UI passed 14 session
continuity samples and a hosted open-login-tab/cold-module check. Both asset
packages retained the immutable union. Backend, schema, encryption protocol and
production flags were unchanged throughout this frontend rehearsal.

Two earlier attempts remain failures: a private harness reread a browser response
after navigation, and a later attempt failed its initial freshness predicate.
The first was reproduced locally and fixed by caching verified document bytes.
Its fixtures were cleaned before a fresh attempt. The second created no fixtures
and never activated; its rejected health response was not retained, so the exact
age/status is unknown. Subsequent attempts record every bounded read-only
freshness check before fixture creation. Thresholds were unchanged and no
unknown mutation was replayed.

Service workers were blocked. The new page shared a session and remembered keys;
this is not fresh-device onboarding. A background profile-setup warning remained
visible, with cause unverified. Physical native devices, production feature
promotion, reusable unattended browser acceptance, and monthly availability
remain separate requirements. Track release work in #3 and invitation work in #41.
