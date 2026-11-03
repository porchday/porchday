-- An attached photo can acquire album paths without altering its original post.
-- Keep source identity after the original post is removed; album copies remain
-- independent, with the original deadline, until the owner deletes the photo.
ALTER TABLE app.photos ADD COLUMN source_media_id uuid UNIQUE;
ALTER TABLE app.photos ADD COLUMN source_post_id uuid;
ALTER TABLE app.photos ADD CONSTRAINT photo_source_identity CHECK(source_media_id IS NULL OR (source_media_id=id AND source_post_id IS NOT NULL));
CREATE FUNCTION app.link_photo_source(p uuid,media uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE photo app.photos;source app.media_assets;original app.posts;deadline timestamptz;
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 PERFORM app.lock_epoch();
 SELECT * INTO photo FROM app.photos WHERE id=p FOR UPDATE;
 SELECT * INTO source FROM app.media_assets WHERE id=media FOR UPDATE;
 SELECT * INTO original FROM app.posts WHERE id=source.post_id;
 IF photo.id IS NULL OR photo.owner_id<>app.actor() OR p<>media OR photo.source_media_id IS NOT NULL
 OR source.id IS NULL OR source.owner_id<>app.actor() OR source.state<>'attached' OR original.author_id IS DISTINCT FROM app.actor()
 OR NOT app.can_media(media) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 deadline:=app.media_deadline(media);
 IF photo.expires_at IS DISTINCT FROM deadline THEN RAISE EXCEPTION 'SOURCE_EXPIRY_CHANGED';END IF;
 IF NOT EXISTS(SELECT FROM app.photo_grants WHERE photo_id=p AND album_id IS NULL AND audience='only_me')
 OR NOT EXISTS(SELECT FROM app.attachment_photo_dates WHERE media_id=media AND photo_date=photo.photo_date)
 THEN RAISE EXCEPTION 'SOURCE_PHOTO_CHANGED';END IF;
 UPDATE app.photos SET source_media_id=media,source_post_id=source.post_id WHERE id=p;
END $$;
CREATE FUNCTION app.delete_photo_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 DELETE FROM app.media_assets WHERE id=OLD.source_media_id AND owner_id=OLD.owner_id;
 RETURN NULL;
END $$;
CREATE TRIGGER delete_photo_source AFTER DELETE ON app.photos FOR EACH ROW EXECUTE FUNCTION app.delete_photo_source();
-- Both representations must use the owner's same signed calendar date. The
-- photo edit route updates logical metadata and the source date atomically.
DO $migration$
DECLARE definition text;needle text:='PERFORM app.lock_epoch();';
BEGIN
 SELECT pg_get_functiondef('app.set_attachment_photo_date(uuid,jsonb)'::regprocedure) INTO definition;
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_ATTACHMENT_DATE_WRITER';END IF;
 EXECUTE replace(definition,needle,needle||$new$
 IF EXISTS(SELECT FROM app.photos WHERE source_media_id=media AND photo_date IS DISTINCT FROM (s->>'date')::date) THEN RAISE EXCEPTION 'PHOTO_DATE_REQUIRES_ALL_PATHS';END IF;
 $new$);
END $migration$;
REVOKE ALL ON FUNCTION app.link_photo_source(uuid,uuid),app.delete_photo_source() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.link_photo_source(uuid,uuid) TO porchday_social;
