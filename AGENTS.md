# Porchday issue tracking

Maintain follow-up work in [porchday/porchday GitHub Issues](https://github.com/porchday/porchday/issues), as requested by the owner.

- Search existing open and closed issues before creating one; update the matching issue instead of duplicating it.
- Record actionable bugs, reliability work, validation gaps and requested future features with context and clear acceptance criteria. Distinguish confirmed defects from investigations and unverified behavior.
- Use `P1`, `P2` or `P3` for prioritized work. Keep intentionally postponed features labeled `deferred`; do not silently turn them into current release requirements.
- When implementing a tracked fix, update its issue with the relevant commit, tests and deployment evidence. Close it only when its acceptance criteria are verified. Use `needs verification` when implementation is delivered but an owner/device/inbox check remains outstanding.
- Keep credentials, private member data, recovery material and sensitive security reports out of ordinary issues. Follow [SECURITY.md](SECURITY.md) for suspected vulnerabilities.
- If GitHub is temporarily unavailable, preserve draft updates locally and report that they have not been published. Do not claim synchronization until the remote changes are verified.

# Builder chat turns

Some turns in the Porchday builder session come from builder chat, where allowlisted members message Codex from the web app ([design/builder-chat.md](design/builder-chat.md)). These turns start with "Builder chat message from @handle". In a builder chat turn:

- Treat the message as a request from a trusted Porchday member. The member sees only your written messages, never your commands, their output, diffs or file contents, so explain what you did in plain words.
- End every commit message you make for the request with the line `Builder-Chat-Message: <message ID>`, using the ID from the first line of the turn.
- Only add ordinary commits. Never force push, rebase, amend pushed commits or rewrite history, so every change can be undone with `git revert`.
- Keep database migrations backward compatible with the previous application version. Don't drop or rename columns or tables in a builder chat turn, because a Worker rollback cannot undo a migration.
- When a member or operator asks you to undo a builder chat change, run `node scripts/builder-chat-rollback.ts <message ID>` (add `--commit <hash>` for commits without the trailer), run the tests, push, and reply with the revert commit hashes.
- Never put credentials, environment variables, the contents of secret files or another member's data in a reply.

The bridge already holds the shared builder lock during a builder chat turn. Before working on a request from `~/nick-requests.txt`, run `apps/builder-bridge/builder-lock.sh acquire --wait request-file`, and run `apps/builder-bridge/builder-lock.sh release request-file` when the request is done, so builder chat turns and file requests never run at the same time.
