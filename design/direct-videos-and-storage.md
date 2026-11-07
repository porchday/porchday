# Direct videos and per-person media storage

The owner requests 10 GB total storage per person and videos shared directly from Share, without a post. Use 10,000,000,000 bytes for the total allowance. Keep per-video source, duration and prepared-file limits separate.

Direct videos are independent media records using the existing photo lifecycle: audiences, album grants, dates, comments/reactions, expiry, feed publication and deletion. Reuse segmented encrypted streams instead of embedding a whole video in a photo envelope. Persist ciphertext-only publication state before upload so retries reconcile the same identity and survive an interrupted response.

Independent segmented video metadata uses videoVersion 3 (its chunk manifest remains protocol v2). The owner source proof binds the canonical validated encrypted stream manifest, including chunk hashes and key/nonce metadata; each grant wraps the same manifest. Playback and resharing verify this binding. Earlier clients do not treat version 3 as a playable segmented attachment, avoiding unverified owner-content playback. Existing post videos remain version 2.

Stream ownership stays with the uploader. Album administrators may rewrap an existing video's keys only for the same photo and album they administer, with the existing refresh authorization and recipient snapshot. They cannot borrow another stream for an unrelated photo. Quota counts stored streams once and envelopes against their final owner; owner reassignment must also enforce the quota.

Acceptance includes direct publication without a post, feed/album playback and source-proof checks, date/caption changes, album administration/permission revocation, retries/cancellation, export/import, deletion/expiry, mixed uploads, quota boundaries and concurrent reservations. Migrations remain additive/backward compatible. Current native apps use the shared web UI; automated native checks precede production, with physical acceptance tracked separately.
