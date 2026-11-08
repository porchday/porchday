# Share draft autosave

Owner request: keep an unsent post when navigating away from Share. Tracked in #187.

Share stays mounted inside the signed-in app while another route is visible. This preserves selections and active local media preparation without disabling navigation. The composer is keyed by account, and is destroyed on sign-out/lock. This is the default experience in the web/PWA and the iOS/macOS web shells; the optional previous Swift interface is a migration fallback.

The composer autosaves after a short typing pause and on page visibility loss. Draft text, photos/videos, original dates, captions, tags, posting identity, audience, expiry selection and Share mode/album selection are local to this account on this device. They are not uploaded or automatically published. A status distinguishes saving, saved, restored and failed storage. Discard explicitly confirms before deleting the draft. Successful post publication clears it; a failed publication retains it. A recorded publication ID lets restoration check whether a post or durable encrypted upload already owns the draft after an interrupted response.

IndexedDB stores signed OpenPGP-encrypted metadata addressed to the active device key. File names, captions, tags and media keys are inside that envelope. Attachment bytes use AES-GCM chunks with fresh per-file keys, random nonces, and account/scope/file/index binding. Only ciphertext reaches persistent draft storage. Unchanged attachments are reused when editing text. Restoring requires the account's unlocked encryption keys. Drafts are not a cross-device sync or a backup against clearing browser data.

An atomic head swap publishes the complete saved draft only after media writes finish. Failed storage leaves the previous head intact. A serialized save/clear queue prevents pending writes from resurrecting a discarded draft. Revision comparison detects competing tabs instead of silently replacing another tab's edits. Superseded ciphertext is removed after the new head commits. Incomplete writes can be removed by discarding the draft. No saved status is shown on failure. Unsaved changes retain the browser unload guard; switching app routes does not trigger it. The app-update control may reload a fully saved draft.

Verification runs in Chromium and WebKit and covers navigation, reload with photos/dates, failed and successful posting, quota failure/retry, discard/reload, multi-chunk media, account isolation and concurrent revision conflicts. Exact-source iOS/macOS CI is required before production; physical storage/OS eviction checks remain separate follow-up in #49/#114. Existing native web-shell builds receive the web update without a new binary.

Ordinary photo/text publication does not query the large-video filesystem outbox during final cleanup. A WebKit filesystem failure must not replace a confirmed post success with an error. Only durable video drafts consult the outbox during recovery.
