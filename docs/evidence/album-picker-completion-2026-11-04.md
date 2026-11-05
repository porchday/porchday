# Album picker completion — November 4, 2026

[PR #146](https://github.com/porchday/porchday/pull/146) fixes the confusing completion state reported in #123. Previously, the picker displayed a success count after each item, remained busy while awaiting a separate album metadata refresh, and did not close on full success.

The picker now displays current/total progress while saving, automatically closes after all selected writes succeed, and leaves the completion notice on the album page. The photo list refresh does not await album metadata. Partial failures retain successful items and keep only unfinished selections available for retry. Photo mutations and permissions are unchanged.

## Verification

- Exact-source CI passed for web commit `6159510573dc850e4643e9b5e254ee8f45b1d7ab`, including typechecks, build, secret scanning and browser regressions.
- The Chromium picker regression covers 320/390/1200px layouts, a delayed save, a never-resolving refresh callback, total failure, partial failure and retry without repeating successful writes, and automatic modal dismissal.
- Staging and production encrypted-content browser acceptance both added an existing standalone photo and an old post attachment, verified automatic dismissal and the album-page “2 photos added” confirmation, and checked rendered album photos and preserved audiences. Existing Feed, Calendar, Share and read-only album controls also passed.
- All frontend activation continuity checks passed, retained assets supported old/new tabs, synthetic fixtures were cleaned up, and final provider inventory/schema verification passed. Backend versions and schema were unchanged.

| Environment | Frontend version |
| --- | --- |
| Staging | `587086ef-8d08-4ae2-a231-a88899c0ba1e` |
| Production | `2e294337-3b35-4ad1-90a4-47eca3a644b4` |

The independent production monitor recorded 8 healthy samples over 140 seconds after activation, with zero failures. This is a bounded release check, not a monthly availability claim.
