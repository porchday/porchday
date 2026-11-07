-- Total stored media is 10 decimal GB; source/prepared video limits are unchanged.
CREATE OR REPLACE FUNCTION app.guard_video_quota() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE total bigint;BEGIN
 PERFORM member_id FROM app.profiles WHERE member_id=NEW.owner_id FOR UPDATE;
 SELECT (SELECT coalesce(sum(byte_size),0) FROM app.media_assets WHERE owner_id=NEW.owner_id)+(SELECT coalesce(sum(byte_size),0) FROM app.video_streams WHERE owner_id=NEW.owner_id) INTO total;
 IF total>10000000000 THEN RAISE EXCEPTION 'MEDIA_QUOTA';END IF;RETURN NEW;
END $$;
-- Check the final replacement state, after the superseded grant is deleted.
CREATE CONSTRAINT TRIGGER guard_reassigned_media_quota AFTER UPDATE ON app.media_assets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.owner_id IS DISTINCT FROM OLD.owner_id) EXECUTE FUNCTION app.guard_video_quota();
DO $$ DECLARE definition text;BEGIN
 SELECT pg_get_functiondef('app.refresh_photo_grant(uuid,uuid,integer,jsonb,uuid)'::regprocedure) INTO definition;
 IF strpos(definition,'>1073741824')=0 THEN RAISE EXCEPTION 'PHOTO_QUOTA_SOURCE_CHANGED';END IF;
 EXECUTE replace(definition,'>1073741824','+(SELECT coalesce(sum(byte_size),0) FROM app.video_streams WHERE owner_id=photo.owner_id)>10000000000');
END $$;

-- A non-owner administrator may only rewrap the same stream for an existing
-- grant of the same photo and album. Final attachment/recipient checks remain in
-- refresh_photo_grant. This cannot create a derivative photo or a new album path.
CREATE FUNCTION app.can_rewrap_photo_video(stream uuid,e jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT e->'context'->>'audience'='album' AND EXISTS(
  SELECT FROM app.photo_grants g JOIN app.media_assets m ON m.id=g.media_id
  JOIN app.photos p ON p.id=g.photo_id JOIN app.video_streams s ON s.id=m.video_stream_id
  WHERE s.id=stream AND s.complete AND s.owner_id=p.owner_id
   AND g.photo_id::text=e->'context'->>'parentId' AND g.album_id::text=e->'context'->>'groupId'
   AND app.album_role(g.album_id)='admin' AND app.can_photo_grant(g.id))
$$;
REVOKE ALL ON FUNCTION app.can_rewrap_photo_video(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_rewrap_photo_video(uuid,jsonb) TO porchday_social;
CREATE OR REPLACE FUNCTION app.guard_video_media() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE s app.video_streams;
BEGIN
 IF TG_OP='UPDATE' AND NEW.video_stream_id IS DISTINCT FROM OLD.video_stream_id THEN RAISE EXCEPTION 'VIDEO_STREAM_IMMUTABLE';END IF;
 IF NEW.video_stream_id IS NOT NULL THEN
  SELECT * INTO s FROM app.video_streams WHERE id=NEW.video_stream_id;
  IF s.id IS NULL OR (s.owner_id IS DISTINCT FROM NEW.owner_id AND NOT app.can_rewrap_photo_video(s.id,NEW.envelope)) THEN RAISE EXCEPTION 'VIDEO_OWNER_MISMATCH';END IF;
  IF NEW.state IN('ready','attached') AND NOT s.complete THEN RAISE EXCEPTION 'VIDEO_INCOMPLETE';END IF;
  IF NEW.profile_member_id IS NOT NULL OR NEW.group_id IS NOT NULL THEN RAISE EXCEPTION 'VIDEO_POST_ONLY';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app.reject_video_photo_grant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF EXISTS(SELECT FROM app.media_assets m JOIN app.video_streams s ON s.id=m.video_stream_id JOIN app.photos p ON p.id=NEW.photo_id WHERE m.id=NEW.media_id AND (NOT s.complete OR s.owner_id<>p.owner_id)) THEN RAISE EXCEPTION 'VIDEO_OWNER_MISMATCH'; END IF;
 RETURN NEW;
END $$;
