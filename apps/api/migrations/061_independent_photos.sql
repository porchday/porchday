-- A photo is not a post. Each independent sharing path has its own encrypted
-- metadata/media version; logical identity and date belong to the photo.
CREATE TABLE app.photos (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 photo_date date NOT NULL CHECK(photo_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE app.photo_grants (
 id uuid PRIMARY KEY,
 photo_id uuid NOT NULL REFERENCES app.photos(id) ON DELETE CASCADE,
 album_id uuid REFERENCES app.albums(id) ON DELETE CASCADE,
 audience text NOT NULL CHECK(audience IN('only_me','connections','friends','family','album')),
 envelope jsonb NOT NULL CHECK(octet_length(envelope::text)<=524288),
 media_id uuid NOT NULL UNIQUE REFERENCES app.media_assets(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((audience='album')=(album_id IS NOT NULL))
);
CREATE UNIQUE INDEX photo_direct_grant ON app.photo_grants(photo_id) WHERE album_id IS NULL;
CREATE UNIQUE INDEX photo_album_grant ON app.photo_grants(photo_id,album_id) WHERE album_id IS NOT NULL;
CREATE INDEX photos_date ON app.photos(photo_date,id);
CREATE INDEX photos_owner ON app.photos(owner_id,id);
CREATE INDEX photo_grants_album ON app.photo_grants(album_id,photo_id);
CREATE TABLE app.photo_grant_recipients (
 grant_id uuid NOT NULL REFERENCES app.photo_grants(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 PRIMARY KEY(grant_id,member_id)
);
ALTER TABLE app.photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.photos FORCE ROW LEVEL SECURITY;
ALTER TABLE app.photo_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.photo_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE app.photo_grant_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.photo_grant_recipients FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app.can_photo_grant(g uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.may_read() AND EXISTS(SELECT FROM app.photo_grants g0 JOIN app.photos p ON p.id=g0.photo_id
 WHERE g0.id=g AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp()) AND NOT app.blocked(p.owner_id,app.actor())
 AND EXISTS(SELECT FROM app.photo_grant_recipients r WHERE r.grant_id=g0.id AND r.member_id=app.actor())
 AND(CASE WHEN g0.album_id IS NOT NULL THEN app.can_album(g0.album_id)
 ELSE p.owner_id=app.actor() OR(g0.audience='connections' AND app.connected(p.owner_id,app.actor()))
 OR(g0.audience='friends' AND app.friends(p.owner_id,app.actor()))
 OR(g0.audience='family' AND app.connected(p.owner_id,app.actor(),true)) END))
$$;
CREATE FUNCTION app.can_photo(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.may_read() AND EXISTS(SELECT FROM app.photos p0 WHERE p0.id=p
 AND(p0.expires_at IS NULL OR p0.expires_at>statement_timestamp()) AND NOT app.blocked(p0.owner_id,app.actor())
 AND(p0.owner_id=app.actor() OR EXISTS(SELECT FROM app.photo_grants g WHERE g.photo_id=p AND app.can_photo_grant(g.id))))
$$;
CREATE POLICY photos_read ON app.photos FOR SELECT USING(app.can_photo(id));
CREATE POLICY photo_grants_read ON app.photo_grants FOR SELECT USING(app.can_photo_grant(id));
CREATE POLICY photo_recipients_read ON app.photo_grant_recipients FOR SELECT USING(app.can_photo_grant(grant_id));
GRANT SELECT ON app.photos,app.photo_grants,app.photo_grant_recipients TO porchday_social;

CREATE FUNCTION app.create_photo(p uuid,d date,expiry timestamptz DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 PERFORM app.lock_epoch();
 IF EXISTS(SELECT FROM app.deletion_ledger WHERE kind='photos' AND object_id=p) THEN RAISE EXCEPTION 'CONTENT_DELETED';END IF;
 IF expiry<=statement_timestamp() THEN RAISE EXCEPTION 'EXPIRED';END IF;
 INSERT INTO app.photos(id,owner_id,photo_date,expires_at) VALUES(p,app.actor(),d,expiry);
END $$;
-- Called only after envelope validation under the directory lock. Never replace
-- another path when an owner adds a photo to an album.
CREATE FUNCTION app.add_photo_grant(g uuid,p uuid,a uuid,e jsonb,media uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE photo app.photos;m app.media_assets;aud text:=e->'context'->>'audience';
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 PERFORM app.lock_epoch();
 IF EXISTS(SELECT FROM app.deletion_ledger WHERE kind='photo_grants' AND object_id=g) THEN RAISE EXCEPTION 'CONTENT_DELETED';END IF;
 SELECT * INTO photo FROM app.photos WHERE id=p FOR UPDATE;
 IF photo.id IS NULL OR photo.owner_id<>app.actor() OR NOT app.can_photo(p) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF a IS NOT NULL AND app.album_role(a) IS DISTINCT FROM 'add' AND app.album_role(a) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF e->'context'->>'id' IS DISTINCT FROM g::text OR e->'context'->>'parentId' IS DISTINCT FROM p::text
 OR e->'context'->>'kind' IS DISTINCT FROM 'photo' OR e->'context'->>'photoDate' IS DISTINCT FROM photo.photo_date::text OR e->'context'->>'authorId' IS DISTINCT FROM photo.owner_id::text
 OR e->'context'->>'groupId' IS DISTINCT FROM a::text OR (e->'context'->>'expiresAt')::timestamptz IS DISTINCT FROM photo.expires_at
 OR (e->'context'->>'revision')::integer IS DISTINCT FROM photo.revision THEN RAISE EXCEPTION 'ENVELOPE_CONTEXT';END IF;
 SELECT * INTO m FROM app.media_assets WHERE id=media FOR UPDATE;
 IF m.id IS NULL OR m.owner_id<>app.actor() OR m.state<>'ready' OR num_nonnulls(m.post_id,m.profile_member_id,m.group_id)>0 THEN RAISE EXCEPTION 'MEDIA_NOT_READY';END IF;
 IF m.envelope->'context'->>'parentId' IS DISTINCT FROM p::text OR m.envelope->'context'->>'audience' IS DISTINCT FROM aud
 OR m.envelope->'context'->>'groupId' IS DISTINCT FROM a::text OR m.envelope->'recipients' IS DISTINCT FROM e->'recipients'
 OR (m.envelope->'context'->>'expiresAt')::timestamptz IS DISTINCT FROM photo.expires_at THEN RAISE EXCEPTION 'MEDIA_AUDIENCE_MISMATCH';END IF;
 IF (SELECT count(*) FROM app.photo_grants WHERE photo_id=p)>=100 THEN RAISE EXCEPTION 'PHOTO_GRANT_LIMIT';END IF;
 INSERT INTO app.photo_grants(id,photo_id,album_id,audience,envelope,media_id) VALUES(g,p,a,aud,e,media);
 INSERT INTO app.photo_grant_recipients(grant_id,member_id) SELECT DISTINCT g,(r->>'memberId')::uuid FROM jsonb_array_elements(e->'recipients') r;
 UPDATE app.media_assets SET state='attached' WHERE id=media;
END $$;
CREATE FUNCTION app.remove_photo_grant(g uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE grant_row app.photo_grants;photo app.photos;
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 PERFORM app.lock_epoch();
 SELECT * INTO grant_row FROM app.photo_grants WHERE id=g;
 SELECT * INTO photo FROM app.photos WHERE id=grant_row.photo_id FOR UPDATE;
 IF photo.id IS NULL OR NOT(photo.owner_id=app.actor() OR(grant_row.album_id IS NOT NULL AND app.album_role(grant_row.album_id)='admin')) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 DELETE FROM app.photo_grants WHERE id=g;
END $$;
CREATE FUNCTION app.delete_photo(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 PERFORM app.lock_epoch();
 DELETE FROM app.photos WHERE id=p AND owner_id=app.actor();
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
END $$;
-- Retain the existing legacy-media checks verbatim, adding independent paths.
DO $migration$
DECLARE definition text;needle text:='(m.post_id IS NULL AND m.profile_member_id IS NULL AND m.group_id IS NULL AND m.owner_id=app.actor()) OR';
BEGIN
 SELECT pg_get_functiondef('app.can_media(uuid)'::regprocedure) INTO definition;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'UNRECOGNIZED_MEDIA_READER';END IF;
 EXECUTE replace(definition,needle,needle||' EXISTS(SELECT FROM app.photo_grants pg WHERE pg.media_id=m.id AND app.can_photo_grant(pg.id)) OR');
END $migration$;
-- Every removed path deletes only its own encrypted media version. Existing
-- media deletion triggers enqueue physical cleanup and privacy tombstones.
CREATE FUNCTION app.journal_photo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF TG_TABLE_NAME='photos' THEN
  INSERT INTO app.deletion_ledger(kind,object_id) VALUES('photos',OLD.id) ON CONFLICT DO NOTHING;
 ELSIF TG_TABLE_NAME='photo_grants' THEN
  INSERT INTO app.deletion_ledger(kind,object_id) VALUES('photo_grants',OLD.id) ON CONFLICT DO NOTHING;
  DELETE FROM app.media_assets WHERE id=OLD.media_id;
 ELSE
  PERFORM app.append_safety_decision(jsonb_build_object('action','photo_recipient_remove','grant',OLD.grant_id,'member',OLD.member_id));
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER journal_photo AFTER DELETE ON app.photos FOR EACH ROW EXECUTE FUNCTION app.journal_photo();
CREATE TRIGGER journal_photo_grant AFTER DELETE ON app.photo_grants FOR EACH ROW EXECUTE FUNCTION app.journal_photo();
CREATE TRIGGER journal_photo_recipient AFTER DELETE ON app.photo_grant_recipients FOR EACH ROW EXECUTE FUNCTION app.journal_photo();
DO $migration$
DECLARE definition text;needle text;
BEGIN
 SELECT pg_get_functiondef('app.replay_safety_batch(jsonb)'::regprocedure) INTO definition;
 needle:=$n$kind IN('posts','comments','groups','media_assets','child_profiles','albums')$n$;
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_RESTORE_READER';END IF;
 definition:=replace(definition,needle,$n$kind IN('posts','comments','groups','media_assets','child_profiles','albums','photos','photo_grants')$n$);
 needle:=$n$WHEN 'connection' THEN$n$;
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_RESTORE_READER';END IF;
 definition:=replace(definition,needle,$n$WHEN 'photo_recipient_remove' THEN DELETE FROM app.photo_grant_recipients WHERE grant_id=(d->>'grant')::uuid AND member_id=(d->>'member')::uuid;
 WHEN 'connection' THEN$n$);
 EXECUTE definition;
END $migration$;
REVOKE ALL ON app.photos,app.photo_grants,app.photo_grant_recipients FROM PUBLIC;
REVOKE ALL ON FUNCTION app.can_photo_grant(uuid),app.can_photo(uuid),app.create_photo(uuid,date,timestamptz),app.add_photo_grant(uuid,uuid,uuid,jsonb,uuid),app.remove_photo_grant(uuid),app.delete_photo(uuid),app.journal_photo() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_photo_grant(uuid),app.can_photo(uuid),app.create_photo(uuid,date,timestamptz),app.add_photo_grant(uuid,uuid,uuid,jsonb,uuid),app.remove_photo_grant(uuid),app.delete_photo(uuid) TO porchday_social;

CREATE OR REPLACE FUNCTION app.media_deadline(media uuid) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT least((m.envelope->'context'->>'expiresAt')::timestamptz,p.expires_at,photo.expires_at)
 FROM app.media_assets m LEFT JOIN app.posts p ON p.id=m.post_id
 LEFT JOIN app.photo_grants g ON g.media_id=m.id LEFT JOIN app.photos photo ON photo.id=g.photo_id WHERE m.id=media
$$;
-- Revocation is persistent. Reconnecting or unblocking does not resurrect a
-- recipient record. A future explicit share must produce a new validated grant.
CREATE FUNCTION app.revoke_photo_relationship() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE a uuid;b uuid;
BEGIN
 IF TG_TABLE_NAME='blocks' THEN
  a:=NEW.actor;b:=NEW.target;
  DELETE FROM app.photo_grant_recipients r USING app.photo_grants g,app.photos p
  WHERE r.grant_id=g.id AND p.id=g.photo_id AND((p.owner_id=a AND r.member_id=b) OR(p.owner_id=b AND r.member_id=a));
 ELSE
  a:=OLD.member_a;b:=OLD.member_b;
  DELETE FROM app.photo_grant_recipients r USING app.photo_grants g,app.photos p
  WHERE r.grant_id=g.id AND p.id=g.photo_id AND g.album_id IS NULL
  AND((p.owner_id=a AND r.member_id=b) OR(p.owner_id=b AND r.member_id=a))
  AND(TG_OP='DELETE' OR(g.audience='friends' AND NOT app.friends(p.owner_id,r.member_id))
   OR(g.audience='family' AND NOT app.connected(p.owner_id,r.member_id,true)));
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER revoke_photo_connection AFTER DELETE OR UPDATE OF kind_a,kind_b ON app.connections FOR EACH ROW EXECUTE FUNCTION app.revoke_photo_relationship();
CREATE TRIGGER revoke_photo_block AFTER INSERT ON app.blocks FOR EACH ROW EXECUTE FUNCTION app.revoke_photo_relationship();
REVOKE ALL ON FUNCTION app.revoke_photo_relationship() FROM PUBLIC;

-- Date/caption updates use only recipients already granted this photo. They
-- must not turn a new connection into a recipient of older photo history.
CREATE FUNCTION app.photo_grant_audience_members(g uuid) RETURNS TABLE(member_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE photo app.photos;grant_row app.photo_grants;
BEGIN
 SELECT * INTO grant_row FROM app.photo_grants WHERE id=g;
 SELECT * INTO photo FROM app.photos WHERE id=grant_row.photo_id;
 IF photo.id IS NULL OR photo.owner_id<>app.actor() OR NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 RETURN QUERY SELECT m.id FROM app.photo_grant_recipients r JOIN app.members m ON m.id=r.member_id
 WHERE r.grant_id=g AND m.status IN('active','restricted') AND NOT app.blocked(photo.owner_id,m.id)
 AND(m.id=photo.owner_id OR CASE WHEN grant_row.album_id IS NOT NULL THEN EXISTS(SELECT FROM app.album_members am JOIN app.albums a ON a.id=am.album_id WHERE am.album_id=grant_row.album_id AND am.member_id=m.id AND NOT app.blocked(a.owner_id,m.id))
 ELSE (grant_row.audience='connections' AND app.connected(photo.owner_id,m.id))
 OR(grant_row.audience='friends' AND app.friends(photo.owner_id,m.id))
 OR(grant_row.audience='family' AND app.connected(photo.owner_id,m.id,true)) END);
END $$;
CREATE FUNCTION app.photo_grant_audience_devices(g uuid) RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT d.id,d.member_id,d.public_key,d.fingerprint FROM app.device_keys d JOIN app.photo_grant_audience_members(g) m ON m.member_id=d.member_id WHERE d.revoked_at IS NULL ORDER BY d.id
$$;
CREATE POLICY photo_grants_owner_read ON app.photo_grants FOR SELECT USING(app.may_read() AND EXISTS(SELECT FROM app.photos p WHERE p.id=photo_id AND p.owner_id=app.actor()));
CREATE FUNCTION app.edit_photo(p uuid,d date,expected integer,envelopes jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE photo app.photos;e jsonb;g app.photo_grants;
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 PERFORM app.lock_epoch();
 SELECT * INTO photo FROM app.photos WHERE id=p FOR UPDATE;
 IF photo.id IS NULL OR photo.owner_id<>app.actor() OR NOT app.can_photo(p) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF photo.revision<>expected THEN RAISE EXCEPTION 'REVISION_CHANGED';END IF;
 IF jsonb_typeof(envelopes) IS DISTINCT FROM 'array' OR jsonb_array_length(envelopes)<>(SELECT count(*) FROM app.photo_grants WHERE photo_id=p)
 OR(SELECT count(DISTINCT value->'context'->>'id') FROM jsonb_array_elements(envelopes))<>jsonb_array_length(envelopes) THEN RAISE EXCEPTION 'ENVELOPE_CONTEXT';END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(envelopes) LOOP
  SELECT * INTO g FROM app.photo_grants WHERE id=(e->'context'->>'id')::uuid AND photo_id=p FOR UPDATE;
  IF g.id IS NULL OR e->'context'->>'parentId' IS DISTINCT FROM p::text OR e->'context'->>'kind' IS DISTINCT FROM 'photo'
  OR e->'context'->>'authorId' IS DISTINCT FROM photo.owner_id::text OR e->'context'->>'audience' IS DISTINCT FROM g.audience
  OR e->'context'->>'groupId' IS DISTINCT FROM g.album_id::text OR e->'context'->>'photoDate' IS DISTINCT FROM d::text
  OR e->'context'->>'createdAt' IS DISTINCT FROM g.envelope->'context'->>'createdAt'
  OR(e->'context'->>'expiresAt')::timestamptz IS DISTINCT FROM photo.expires_at OR(e->'context'->>'revision')::integer IS DISTINCT FROM expected+1 THEN RAISE EXCEPTION 'ENVELOPE_CONTEXT';END IF;
  UPDATE app.photo_grants SET envelope=e WHERE id=g.id;
 END LOOP;
 UPDATE app.photos SET photo_date=d,revision=expected+1 WHERE id=p;
 PERFORM app.append_safety_decision(jsonb_build_object('action','photo_revision','photo',p,'revision',expected+1));
END $$;
-- A restored older metadata revision must be unreadable until its current
-- signed metadata is recovered; an old caption/date must not be resurrected.
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('app.replay_safety_batch(jsonb)'::regprocedure) INTO definition;
 IF strpos(definition,$n$WHEN 'connection' THEN$n$)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_RESTORE_READER';END IF;
 EXECUTE replace(definition,$n$WHEN 'connection' THEN$n$,$n$WHEN 'photo_revision' THEN
  UPDATE app.photo_grants SET envelope='{}' WHERE photo_id=(d->>'photo')::uuid AND EXISTS(SELECT FROM app.photos p WHERE p.id=photo_id AND p.revision<(d->>'revision')::integer);
  UPDATE app.photos SET revision=(d->>'revision')::integer WHERE id=(d->>'photo')::uuid AND revision<(d->>'revision')::integer;
 WHEN 'connection' THEN$n$);
END $migration$;
REVOKE ALL ON FUNCTION app.photo_grant_audience_members(uuid),app.photo_grant_audience_devices(uuid),app.edit_photo(uuid,date,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.photo_grant_audience_members(uuid),app.photo_grant_audience_devices(uuid),app.edit_photo(uuid,date,integer,jsonb) TO porchday_social;
