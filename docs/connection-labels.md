# Personal friend and family labels

Tracked in [issue #25](https://github.com/porchday/porchday/issues/25). The friendship itself requires mutual acceptance; each person's Friend or Family label is their own choice.

## Member behavior

When sending a connection request, choose your label for that person. When accepting a request, choose your own label for its sender; the default is Friend. The labels do not need to match. Each person also makes their own full-history or future-only choice, as described in [history sharing](friend-history-sharing.md).

Connections shows **Your label** and lets you change it immediately without a proposal or approval. Your labels determine the audiences of your own posts. If you label someone Family, your family-only posts can include them; their label for you has no effect on access to your posts. Friends-only excludes the people you label Family, while Friends & family includes both. Existing acceptance, blocks and the combined 300-person limit still apply.

## Migration and compatibility

Migration `047_independent_connection_labels.sql` adds `kind_a` and `kind_b` to each accepted pair and initializes both from the previously agreed label. It preserves the existing independent history preferences. Pending relabel proposals are discarded because they had not changed the effective label. No existing connection is silently reclassified.

The connection API's `kind` field now reports the requesting member's own label. Incoming requests do not expose the sender's label as a shared requirement. The accept endpoint accepts `kind` alongside `history`; older clients that omit `kind` default to Friend for the recipient. Repeated acceptance cannot overwrite either person's recorded choices. The legacy shared database column remains for administrative compatibility and is not an authorization input.

Exports retain the existing `{member_id, kind}` shape, with `kind` representing the exporting member's label. Import treats connections as references and does not silently establish friendships. Exporting independent history preferences remains tracked separately in issue #23.

## Authorization and restoration

The first argument of the database relationship predicates is the content author. Post access, audience snapshots, thread descendants, photos and history refresh all use that author's classification. A member cannot gain access to someone else's family-only posts by changing their own label. Changes serialize with the existing relationship locks and increment the audience epoch so stale recipient snapshots cannot commit new access.

A label change removes the peer's server-side grants for the changing author's posts in the category being left. It does not remove reverse-direction grants or Friends & family posts. Relabeling is not a recall of already downloaded content or keys. An existing full-history preference can authorize new encrypted sharing of eligible posts when a person later moves into that category, including after switching back; an unlocked author device performs that work.

Both label transitions enter the privacy journal because either transition leaves a restricted audience. Restore replay conservatively removes the relationship rather than restoring an older classification or silently recreating access. This reuses the existing connection-removal journal format. Unfriending, blocking, expiration, deletion, key trust and signed-envelope checks keep their existing behavior.

Verification must cover asymmetric labels in both member orderings, independent acceptance defaults and retry, immediate relabeling, directional reads/revocation, exports, stale audience snapshots, and privacy-journal replay. Deployment and hosted acceptance evidence belong in issue #25; local fixtures do not establish a real member's device or inbox acceptance.

## Inviting someone new

New clients send an explicit `kind: friend | family` with a platform invitation.
The sender UI and email explain that accepting the invitation and verifying the
invited email creates a connection with that initial label in both directions.
History is future-only; each person can independently change their own label or
disconnect later. Existing members still use normal connection requests.

Migration `058_invitation_connections.sql` is additive. Invitations without a
label, including those created by older clients, retain admission-only behavior.
Verification creates the relationship transactionally, respecting blocks, member
status and the 300-person limit. Once checked, re-verification cannot restore a
removed connection or overwrite preferences. An unavailable or blocked inviter
cannot gain access through signup.

Senders can revoke pending invitations, including a claimed invitation whose
account has not yet been verified. This invalidates its signup credential and
prevents its automatic connection; it does not delete an account already created.
Joined invitations cannot be revoked as a shortcut to removing a connection.
Revocation and verification serialize on the invitation receipt. Queued delivery
checks the invalidated credential; an email already sent cannot be recalled.

List clients request `?v=2` for the Revoked status. Older web/native clients see
revoked invitations as Expired, which they already support. Suppressed requests
retain the requested label and generic pending receipt without revealing account
existence or another sender's invitation. Rollout applies the expansion, API,
then UI; rollback keeps the expansion and its consent/revocation enforcement.
