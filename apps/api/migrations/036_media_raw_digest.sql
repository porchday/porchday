-- Raw upload bytes and canonical signed-envelope binding have distinct digests.
-- Existing draft fixtures without a raw digest fail backup/release closed.
ALTER TABLE app.media_assets ADD COLUMN raw_sha256 text CHECK(raw_sha256 ~ '^[a-f0-9]{64}$');
