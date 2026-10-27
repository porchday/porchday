# Sent platform invitations

Connections → Invite someone lists the sender's invitation recipients, most
recent request date and Pending / Joined / Expired status. Web/PWA and native iOS
refresh after a successful request and offer Refresh and Load more controls.
One entry per normalized email avoids duplicate rows when a member repeats a
request. The list covers the last 90 days.

- **Pending:** a request was accepted; the recipient has not completed verified
  signup through this sender's invitation. This does not claim inbox delivery.
- **Joined:** the recipient verified an account created using this sender's
  invitation. Claiming a code or creating an unverified account is insufficient.
  Later recipient deletion or account status changes are not disclosed.
- **Expired:** the invitation period passed without that verified signup.
  Joined takes precedence over expiry.

No friendship is created automatically. Existing-account and duplicate
suppression still return the same send response. All newly accepted requests
receive a generic receipt, including suppressed requests. A different sender
cannot see who issued an invitation or whether their recipient used it.

## Storage and authorization

Migration 048 adds a private auth-role history table. Contact addresses use the
existing operational-email AES-GCM protection with an encrypted sender/recipient
binding. These are operational contact details, **not end-to-end encrypted social
content**; the service needs the address for invitation delivery and the sender's
receipt. No invitation code, token hash, claimed account ID, delivery diagnostic
or other sender's history is returned by `GET /api/v1/platform-invitations`.
The endpoint requires a current verified session, checks sender identity again,
uses `private, no-store` responses, and returns at most 50 entries plus an opaque
pagination cursor. The response can be read as JSON by the authenticated sender;
it is separate from the encrypted-content archive.

Admission credentials still expire after seven days. Receipt history expires
after 90 days and cascades away when the sender's auth identity is deleted.
Deleting a recipient clears the internal claim reference without changing the
sender's previously established Joined status. Code claims are retained through
credential cleanup so a pending verification can still complete correctly.
Restore tooling purges invitation receipts together with invalidated invitation
credentials; stale contact history is never resurrected by restoring a backup.

Scheduled cleanup preserves still-retained older member-issued invitations in
bounded batches before deleting their expired credentials. Previously purged
invitations cannot be reconstructed. Older suppressed requests have no saved
email address and cannot be listed retrospectively. New requests are all recorded.
A `history_recorded` marker makes migration idempotent and prevents repeated
backfill of superseded tokens.

## Verification

`platform-invitations.integration.test.ts` uses real PostgreSQL, signed auth
sessions and a restricted auth role to check sender isolation, suppression,
claim-versus-verification transitions, expiry, recipient and sender deletion,
legacy capture, retention, pagination and role permissions. Test email delivery
is mocked. `node scripts/check-invitation-history.mjs` checks the real web form
and list in Chromium/WebKit with synthetic responses, including refresh after
sending, pagination, retry and narrow-layout behavior. Native model checks are
in `PlatformInvitationTests`.

Rollout and remaining acceptance evidence are tracked in
[issue #30](https://github.com/porchday/porchday/issues/30).
