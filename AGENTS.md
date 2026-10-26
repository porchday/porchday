# Porchday issue tracking

Maintain follow-up work in [andyk/porchday GitHub Issues](https://github.com/andyk/porchday/issues), as requested by the owner. The repository is private.

- Search existing open and closed issues before creating one; update the matching issue instead of duplicating it.
- Record actionable bugs, reliability work, validation gaps and requested future features with context and clear acceptance criteria. Distinguish confirmed defects from investigations and unverified behavior.
- Use `P1`, `P2` or `P3` for prioritized work. Keep intentionally postponed features labeled `deferred`; do not silently turn them into current release requirements.
- When implementing a tracked fix, update its issue with the relevant commit, tests and deployment evidence. Close it only when its acceptance criteria are verified. Use `needs verification` when implementation is delivered but an owner/device/inbox check remains outstanding.
- Keep credentials, private member data, recovery material and sensitive security reports out of ordinary issues. Follow [SECURITY.md](SECURITY.md) for suspected vulnerabilities.
- If GitHub is temporarily unavailable, preserve draft updates locally and report that they have not been published. Do not claim synchronization until the remote changes are verified.
