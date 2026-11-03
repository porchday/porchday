-- New direct connections default to full history. Preserve every existing
-- directional choice, including explicit and legacy future-only preferences.
ALTER TABLE app.connection_requests ALTER COLUMN history SET DEFAULT 'full';
ALTER TABLE app.connections ALTER COLUMN history_a SET DEFAULT 'full';
ALTER TABLE app.connections ALTER COLUMN history_b SET DEFAULT 'full';
CREATE OR REPLACE FUNCTION app.accept_connection(request_id uuid) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.accept_connection_with_history(request_id,'full')
$$;
-- Circle membership is solely graph-derived. Direct history preferences do not
-- change Community/Extended family membership or the history of circle content.
CREATE OR REPLACE FUNCTION app.history_audience_members(p uuid) RETURNS TABLE(member_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE source app.posts;
BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT * INTO source FROM app.posts WHERE id=p AND author_id=app.actor()
  AND group_id IS NULL AND audience IN('connections','friends','family','community','extended_family')
  AND(expires_at IS NULL OR expires_at>statement_timestamp());
 IF source.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 RETURN QUERY SELECT current.member_id FROM app.audience_members(source.audience,NULL,NULL) current
 WHERE source.audience IN('community','extended_family') OR current.member_id=app.actor()
 OR EXISTS(SELECT FROM app.post_recipients r WHERE r.post_id=p AND r.member_id=current.member_id)
 OR EXISTS(SELECT FROM app.connections c WHERE c.member_a=least(app.actor(),current.member_id)
  AND c.member_b=greatest(app.actor(),current.member_id)
  AND CASE WHEN c.member_a=app.actor() THEN c.history_a ELSE c.history_b END='full')
 ORDER BY current.member_id;
END $$;

-- Owners refresh original photo audiences; album administration stays unchanged.
CREATE OR REPLACE FUNCTION app.photo_refresh_members(g uuid) RETURNS TABLE(member_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE grant_row app.photo_grants;photo app.photos;
BEGIN
 SELECT * INTO grant_row FROM app.photo_grants WHERE id=g;
 SELECT * INTO photo FROM app.photos WHERE id=grant_row.photo_id;
 IF NOT app.may_write() OR photo.id IS NULL OR NOT app.can_photo_grant(g) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF grant_row.album_id IS NULL THEN
  IF photo.owner_id<>app.actor() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  RETURN QUERY SELECT current.member_id FROM app.audience_members(grant_row.audience,NULL,NULL) current
  WHERE grant_row.audience IN('community','extended_family') OR current.member_id=app.actor()
   OR EXISTS(SELECT FROM app.photo_grant_recipients r WHERE r.grant_id=g AND r.member_id=current.member_id)
   OR EXISTS(SELECT FROM app.connections c WHERE c.member_a=least(app.actor(),current.member_id)
    AND c.member_b=greatest(app.actor(),current.member_id)
    AND CASE WHEN c.member_a=app.actor() THEN c.history_a ELSE c.history_b END='full');
  RETURN;
 END IF;
 IF app.album_role(grant_row.album_id) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 RETURN QUERY SELECT m.id FROM app.members m WHERE m.status IN('active','restricted') AND NOT app.blocked(photo.owner_id,m.id)
 AND(m.id=photo.owner_id OR EXISTS(SELECT FROM app.album_members am JOIN app.albums a ON a.id=am.album_id WHERE am.album_id=grant_row.album_id AND am.member_id=m.id AND NOT app.blocked(a.owner_id,m.id)));
END $$;
CREATE OR REPLACE FUNCTION app.photo_refresh_devices(g uuid) RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT d.id,d.member_id,d.public_key,d.fingerprint FROM app.device_keys d JOIN app.photo_refresh_members(g) m ON m.member_id=d.member_id WHERE d.revoked_at IS NULL ORDER BY d.id
$$;
CREATE OR REPLACE FUNCTION app.refresh_photo_grant(g uuid,expected_media uuid,expected_revision integer,e jsonb,media uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE grant_row app.photo_grants;photo app.photos;m app.media_assets;
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 PERFORM app.lock_epoch();
 SELECT * INTO grant_row FROM app.photo_grants WHERE id=g;
 SELECT * INTO photo FROM app.photos WHERE id=grant_row.photo_id FOR UPDATE;
 SELECT * INTO grant_row FROM app.photo_grants WHERE id=g FOR UPDATE;
 IF photo.id IS NULL OR NOT app.can_photo_grant(g) OR (CASE WHEN grant_row.album_id IS NULL THEN photo.owner_id<>app.actor() ELSE app.album_role(grant_row.album_id) IS DISTINCT FROM 'admin' END) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF grant_row.media_id<>expected_media OR photo.revision<>expected_revision THEN RAISE EXCEPTION 'REVISION_CHANGED';END IF;
 IF e->'context'->>'id' IS DISTINCT FROM g::text OR e->'context'->>'parentId' IS DISTINCT FROM photo.id::text
 OR e->'context'->>'kind' IS DISTINCT FROM 'photo' OR e->'context'->>'authorId' IS DISTINCT FROM app.actor()::text
 OR e->'context'->>'audience' IS DISTINCT FROM grant_row.audience OR e->'context'->>'groupId' IS DISTINCT FROM grant_row.album_id::text
 OR e->'context'->>'photoDate' IS DISTINCT FROM photo.photo_date::text OR (e->'context'->>'revision')::integer IS DISTINCT FROM photo.revision
 OR(e->'context'->>'expiresAt')::timestamptz IS DISTINCT FROM photo.expires_at THEN RAISE EXCEPTION 'ENVELOPE_CONTEXT';END IF;
 SELECT * INTO m FROM app.media_assets WHERE id=media FOR UPDATE;
 IF m.id IS NULL OR m.owner_id<>app.actor() OR m.state<>'ready' OR num_nonnulls(m.post_id,m.profile_member_id,m.group_id)>0 THEN RAISE EXCEPTION 'MEDIA_NOT_READY';END IF;
 IF m.envelope->'context'->>'parentId' IS DISTINCT FROM photo.id::text OR m.envelope->'context'->>'groupId' IS DISTINCT FROM grant_row.album_id::text
 OR m.envelope->'context'->>'audience' IS DISTINCT FROM grant_row.audience OR m.envelope->'recipients' IS DISTINCT FROM e->'recipients'
 OR(m.envelope->'context'->>'expiresAt')::timestamptz IS DISTINCT FROM photo.expires_at THEN RAISE EXCEPTION 'MEDIA_AUDIENCE_MISMATCH';END IF;
 -- Serialize with the ordinary owner quota reservation lock. Replacement bytes
 -- belong to the photo, so deleting an administering account cannot erase it.
 PERFORM 1 FROM app.profiles WHERE member_id=photo.owner_id FOR UPDATE;
 IF (SELECT coalesce(sum(byte_size),0) FROM app.media_assets WHERE owner_id=photo.owner_id AND id NOT IN(expected_media,media))+m.byte_size>1073741824 THEN RAISE EXCEPTION 'MEDIA_QUOTA';END IF;
 UPDATE app.media_assets SET state='attached',owner_id=photo.owner_id WHERE id=media;
 UPDATE app.photo_grants SET envelope=e,media_id=media WHERE id=g;
 -- Only removals are journaled; keep retained recipients in place.
 DELETE FROM app.photo_grant_recipients r WHERE r.grant_id=g AND NOT EXISTS(SELECT FROM jsonb_array_elements(e->'recipients') x WHERE (x->>'memberId')::uuid=r.member_id);
 INSERT INTO app.photo_grant_recipients(grant_id,member_id) SELECT DISTINCT g,(x->>'memberId')::uuid FROM jsonb_array_elements(e->'recipients') x ON CONFLICT DO NOTHING;
 DELETE FROM app.media_assets WHERE id=expected_media;
END $$;
