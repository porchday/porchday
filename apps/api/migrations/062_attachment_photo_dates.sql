-- Existing attachments retain their original post/media access checks. A signed
-- date record changes only photo calendar placement, never post chronology.
CREATE TABLE app.attachment_photo_dates (
 media_id uuid PRIMARY KEY REFERENCES app.media_assets(id) ON DELETE CASCADE,
 photo_date date CHECK(photo_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 revision integer NOT NULL CHECK(revision>0),
 proof jsonb NOT NULL,
 author_key jsonb NOT NULL
);
ALTER TABLE app.attachment_photo_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attachment_photo_dates FORCE ROW LEVEL SECURITY;
CREATE POLICY attachment_photo_dates_read ON app.attachment_photo_dates FOR SELECT USING(app.can_media(media_id));
GRANT SELECT ON app.attachment_photo_dates TO porchday_social;
CREATE FUNCTION app.set_attachment_photo_date(media uuid,e jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE m app.media_assets;p app.posts;current_revision integer;key jsonb;s jsonb:=e->'statement';
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 PERFORM app.lock_epoch();
 SELECT * INTO m FROM app.media_assets WHERE id=media FOR UPDATE;
 SELECT * INTO p FROM app.posts WHERE id=m.post_id;
 IF p.id IS NULL OR p.author_id<>app.actor() OR m.owner_id<>app.actor() OR m.state<>'attached' OR NOT app.can_media(media) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT revision INTO current_revision FROM app.attachment_photo_dates WHERE media_id=media;
 IF(s->>'revision')::integer IS DISTINCT FROM coalesce(current_revision,0)+1 THEN RAISE EXCEPTION 'REVISION_CHANGED';END IF;
 IF s->>'mediaId' IS DISTINCT FROM media::text OR s->>'postId' IS DISTINCT FROM p.id::text OR s->>'ownerId' IS DISTINCT FROM p.author_id::text OR s->>'purpose' IS DISTINCT FROM 'porchday-attachment-date' THEN RAISE EXCEPTION 'ENVELOPE_CONTEXT';END IF;
 SELECT jsonb_build_object('id',d.id,'member_id',d.member_id,'public_key',d.public_key,'fingerprint',d.fingerprint) INTO key FROM app.device_keys d WHERE d.id=(s->>'deviceId')::uuid AND d.member_id=app.actor() AND d.revoked_at IS NULL;
 IF key IS NULL THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 INSERT INTO app.attachment_photo_dates(media_id,photo_date,revision,proof,author_key) VALUES(media,(s->>'date')::date,(s->>'revision')::integer,e,key)
 ON CONFLICT(media_id) DO UPDATE SET photo_date=excluded.photo_date,revision=excluded.revision,proof=excluded.proof,author_key=excluded.author_key;
 PERFORM app.append_safety_decision(jsonb_build_object('action','attachment_photo_date_revision','media',media,'revision',(s->>'revision')::integer));
END $$;
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('app.replay_safety_batch(jsonb)'::regprocedure) INTO definition;
 IF strpos(definition,$n$WHEN 'connection' THEN$n$)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_RESTORE_READER';END IF;
 EXECUTE replace(definition,$n$WHEN 'connection' THEN$n$,$n$WHEN 'attachment_photo_date_revision' THEN
 INSERT INTO app.attachment_photo_dates(media_id,photo_date,revision,proof,author_key) SELECT (d->>'media')::uuid,NULL,(d->>'revision')::integer,'{}','{}' WHERE EXISTS(SELECT FROM app.media_assets WHERE id=(d->>'media')::uuid) ON CONFLICT(media_id) DO UPDATE SET photo_date=NULL,proof='{}',revision=excluded.revision WHERE app.attachment_photo_dates.revision<excluded.revision;
 WHEN 'connection' THEN$n$);
END $migration$;
REVOKE ALL ON app.attachment_photo_dates FROM PUBLIC;
REVOKE ALL ON FUNCTION app.set_attachment_photo_date(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_attachment_photo_date(uuid,jsonb) TO porchday_social;
