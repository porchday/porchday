-- Video bytes remain private objects. Existing media rows contain only the
-- small signed/encrypted manifest; their existing recipient and expiry rules
-- authorize every chunk. History grants may reference the same immutable stream.
CREATE TABLE app.video_streams (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 17 AND 262145008),
 specification jsonb NOT NULL CHECK(jsonb_typeof(specification)='array' AND jsonb_array_length(specification) BETWEEN 1 AND 63),
 complete boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_stream_owner ON app.video_streams(owner_id);
ALTER TABLE app.media_assets ADD COLUMN video_stream_id uuid REFERENCES app.video_streams(id) ON DELETE CASCADE;
CREATE INDEX media_video_stream ON app.media_assets(video_stream_id) WHERE video_stream_id IS NOT NULL;
CREATE TABLE app.video_chunks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 stream_id uuid NOT NULL REFERENCES app.video_streams(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 62),
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 17 AND 4194320),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 object_key text NOT NULL UNIQUE,
 received_at timestamptz,
 UNIQUE(stream_id,chunk_index),
 CHECK(object_key='media/'||owner_id::text||'/'||id::text)
);
ALTER TABLE app.video_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.video_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.video_streams,app.video_chunks FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.video_streams,app.video_chunks TO porchday_social;
CREATE FUNCTION app.can_video_stream(stream uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.may_read() AND EXISTS(SELECT FROM app.media_assets m WHERE m.video_stream_id=stream AND app.can_media(m.id)) AND NOT EXISTS(SELECT FROM app.video_chunks c JOIN app.deletion_outbox d ON d.object_key=c.object_key WHERE c.stream_id=stream)
$$;
REVOKE ALL ON FUNCTION app.can_video_stream(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_video_stream(uuid) TO porchday_social;
CREATE POLICY video_stream_read ON app.video_streams FOR SELECT USING(app.can_video_stream(id) OR(owner_id=app.actor() AND app.may_read()));
CREATE POLICY video_stream_create ON app.video_streams FOR INSERT WITH CHECK(owner_id=app.actor() AND app.may_write() AND NOT complete);
CREATE POLICY video_stream_update ON app.video_streams FOR UPDATE USING(owner_id=app.actor() AND app.may_write()) WITH CHECK(owner_id=app.actor() AND app.may_write());
CREATE POLICY video_stream_delete ON app.video_streams FOR DELETE USING(owner_id=app.actor() AND app.may_read());
CREATE POLICY video_chunk_read ON app.video_chunks FOR SELECT USING(app.can_video_stream(stream_id) OR(owner_id=app.actor() AND app.may_read()));
CREATE POLICY video_chunk_create ON app.video_chunks FOR INSERT WITH CHECK(owner_id=app.actor() AND app.may_write() AND EXISTS(SELECT FROM app.video_streams s WHERE s.id=stream_id AND s.owner_id=app.actor() AND NOT s.complete));
CREATE POLICY video_chunk_update ON app.video_chunks FOR UPDATE USING(owner_id=app.actor() AND app.may_write()) WITH CHECK(owner_id=app.actor() AND app.may_write());
-- No direct chunk DELETE permission through RLS: deleting the stream cascades
-- through the same durable object-deletion journal as existing media.
CREATE FUNCTION app.guard_video_chunk() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE s app.video_streams; expected jsonb;
BEGIN
 SELECT * INTO s FROM app.video_streams WHERE id=NEW.stream_id FOR UPDATE;
 expected=s.specification->NEW.chunk_index;
 IF EXISTS(SELECT FROM app.deletion_outbox WHERE object_key=NEW.object_key) OR EXISTS(SELECT FROM app.deletion_ledger WHERE kind='media_assets' AND object_id=NEW.id) THEN RAISE EXCEPTION 'CONTENT_DELETED';END IF;
 IF s.id IS NULL OR NEW.owner_id<>s.owner_id OR s.complete OR
    (expected->>'index')::integer IS DISTINCT FROM NEW.chunk_index OR
    (expected->>'size')::integer IS DISTINCT FROM NEW.byte_size OR
    expected->>'sha256' IS DISTINCT FROM NEW.sha256 THEN RAISE EXCEPTION 'VIDEO_CHUNK_MISMATCH'; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'received_at' IS DISTINCT FROM to_jsonb(OLD)-'received_at' OR OLD.received_at IS NOT NULL) THEN RAISE EXCEPTION 'VIDEO_CHUNK_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_video_chunk BEFORE INSERT OR UPDATE ON app.video_chunks FOR EACH ROW EXECUTE FUNCTION app.guard_video_chunk();
CREATE FUNCTION app.guard_video_stream() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF to_jsonb(NEW)-'complete' IS DISTINCT FROM to_jsonb(OLD)-'complete' OR OLD.complete THEN RAISE EXCEPTION 'VIDEO_STREAM_IMMUTABLE';END IF;
 IF NEW.complete AND (SELECT count(*)<>jsonb_array_length(NEW.specification) OR count(*) FILTER(WHERE received_at IS NULL)>0 OR coalesce(sum(byte_size),0)<>NEW.byte_size FROM app.video_chunks WHERE stream_id=NEW.id) THEN RAISE EXCEPTION 'VIDEO_INCOMPLETE';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_video_stream BEFORE UPDATE ON app.video_streams FOR EACH ROW EXECUTE FUNCTION app.guard_video_stream();
CREATE FUNCTION app.guard_video_media() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE s app.video_streams;
BEGIN
 IF TG_OP='UPDATE' AND NEW.video_stream_id IS DISTINCT FROM OLD.video_stream_id THEN RAISE EXCEPTION 'VIDEO_STREAM_IMMUTABLE';END IF;
 IF NEW.video_stream_id IS NOT NULL THEN
  SELECT * INTO s FROM app.video_streams WHERE id=NEW.video_stream_id;
  IF s.owner_id IS DISTINCT FROM NEW.owner_id THEN RAISE EXCEPTION 'VIDEO_OWNER_MISMATCH';END IF;
  IF NEW.state IN('ready','attached') AND NOT s.complete THEN RAISE EXCEPTION 'VIDEO_INCOMPLETE';END IF;
  IF NEW.profile_member_id IS NOT NULL OR NEW.group_id IS NOT NULL OR EXISTS(SELECT FROM app.photo_grants WHERE media_id=NEW.id) THEN RAISE EXCEPTION 'VIDEO_POST_ONLY';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_video_media BEFORE INSERT OR UPDATE ON app.media_assets FOR EACH ROW EXECUTE FUNCTION app.guard_video_media();
CREATE TRIGGER video_chunk_deletion BEFORE DELETE ON app.video_chunks FOR EACH ROW EXECUTE FUNCTION app.enqueue_media_deletion();
CREATE FUNCTION app.expire_video_streams(batch_size integer DEFAULT 200) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE removed integer;
BEGIN
 IF batch_size<1 OR batch_size>1000 THEN RAISE EXCEPTION 'INVALID_BATCH';END IF;
 DELETE FROM app.video_streams s WHERE s.id IN(SELECT v.id FROM app.video_streams v WHERE NOT EXISTS(SELECT FROM app.media_assets m WHERE m.video_stream_id=v.id) LIMIT batch_size FOR UPDATE SKIP LOCKED);
 GET DIAGNOSTICS removed=ROW_COUNT;RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.guard_video_chunk(),app.guard_video_stream(),app.guard_video_media(),app.expire_video_streams(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.expire_video_streams(integer) TO porchday_jobs;
-- Extend the existing expiry function in place, preserving photo retention and
-- every other previously deployed lifecycle rule.
DO $$ DECLARE definition text;needle text:='RETURN jsonb_build_object(';BEGIN
 SELECT pg_get_functiondef('app.expire_batch(integer)'::regprocedure) INTO definition;
 IF length(definition)-length(replace(definition,needle,''))<>length(needle) THEN RAISE EXCEPTION 'VIDEO_EXPIRY_SOURCE_CHANGED';END IF;
 EXECUTE replace(definition,needle,'PERFORM app.expire_video_streams(batch_size); '||needle);
END $$;
-- Both daily and manual backups freeze their additional chunk inventory in the
-- same transaction as the run. Existing backup format/readers already support
-- these private media keys and bounded object sizes.
CREATE FUNCTION app.snapshot_video_chunks() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 INSERT INTO app.media_backup_items(run_id,object_key,canonical_sha256,sha256,byte_size)
 SELECT NEW.id,c.object_key,c.sha256,c.sha256,c.byte_size FROM app.video_chunks c JOIN app.video_streams s ON s.id=c.stream_id
 WHERE s.complete AND c.received_at IS NOT NULL AND EXISTS(SELECT FROM app.media_assets m WHERE m.video_stream_id=s.id AND m.state IN('ready','attached') AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>NEW.restore_at));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.snapshot_video_chunks() FROM PUBLIC;
CREATE TRIGGER snapshot_video_chunks AFTER INSERT ON app.media_backup_runs FOR EACH ROW EXECUTE FUNCTION app.snapshot_video_chunks();

-- Database quota enforcement also covers older application versions during a
-- rollback, which do not yet know to include reserved stream bytes.
CREATE FUNCTION app.guard_video_quota() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE total bigint;BEGIN
 PERFORM member_id FROM app.profiles WHERE member_id=NEW.owner_id FOR UPDATE;
 SELECT (SELECT coalesce(sum(byte_size),0) FROM app.media_assets WHERE owner_id=NEW.owner_id)+(SELECT coalesce(sum(byte_size),0) FROM app.video_streams WHERE owner_id=NEW.owner_id) INTO total;
 IF total>1073741824 THEN RAISE EXCEPTION 'MEDIA_QUOTA';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_video_quota() FROM PUBLIC;
CREATE TRIGGER guard_video_quota AFTER INSERT ON app.video_streams FOR EACH ROW EXECUTE FUNCTION app.guard_video_quota();
CREATE TRIGGER guard_all_media_quota AFTER INSERT ON app.media_assets FOR EACH ROW EXECUTE FUNCTION app.guard_video_quota();

CREATE FUNCTION app.reject_video_photo_grant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF EXISTS(SELECT FROM app.media_assets WHERE id=NEW.media_id AND video_stream_id IS NOT NULL) THEN RAISE EXCEPTION 'VIDEO_POST_ONLY'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reject_video_photo_grant() FROM PUBLIC;
CREATE TRIGGER reject_video_photo_grant BEFORE INSERT OR UPDATE ON app.photo_grants FOR EACH ROW EXECUTE FUNCTION app.reject_video_photo_grant();
