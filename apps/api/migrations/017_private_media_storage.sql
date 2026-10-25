-- Full ciphertext belongs in private object storage, not duplicated in every
-- feed/export SQL result. Existing ready objects remain usable via R2.
ALTER TABLE app.media_assets ADD COLUMN envelope_sha256 text CHECK(envelope_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE app.media_assets ADD COLUMN profile_member_id uuid REFERENCES app.profiles(member_id) ON DELETE CASCADE;
ALTER TABLE app.media_assets ADD COLUMN group_id uuid REFERENCES app.groups(id) ON DELETE CASCADE;
ALTER TABLE app.media_assets ADD COLUMN slot text CHECK(slot IN('avatar','cover','background','image'));
ALTER TABLE app.media_assets ADD CONSTRAINT media_single_parent CHECK(num_nonnulls(post_id,profile_member_id,group_id)<=1);
ALTER TABLE app.media_assets ADD CONSTRAINT media_surface_slot CHECK((profile_member_id IS NULL AND group_id IS NULL)=(slot IS NULL));
UPDATE app.media_assets SET envelope=envelope-'ciphertext';
ALTER TABLE app.media_assets ADD CONSTRAINT media_metadata_only CHECK(NOT envelope ? 'ciphertext');
CREATE UNIQUE INDEX media_profile_slot ON app.media_assets(profile_member_id,slot) WHERE profile_member_id IS NOT NULL;
CREATE UNIQUE INDEX media_group_slot ON app.media_assets(group_id,slot) WHERE group_id IS NOT NULL;

CREATE FUNCTION app.media_deadline(media uuid) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT least((m.envelope->'context'->>'expiresAt')::timestamptz,p.expires_at) FROM app.media_assets m LEFT JOIN app.posts p ON p.id=m.post_id WHERE m.id=media
$$;
CREATE FUNCTION app.can_media(media uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.may_read() AND EXISTS(SELECT FROM app.media_assets m WHERE m.id=media AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp()) AND(
 (m.post_id IS NULL AND m.profile_member_id IS NULL AND m.group_id IS NULL AND m.owner_id=app.actor()) OR
 (m.post_id IS NOT NULL AND app.can_post(m.post_id)) OR
 (m.profile_member_id IS NOT NULL AND app.can_profile(m.profile_member_id) AND m.envelope->'recipients' @> jsonb_build_array(jsonb_build_object('memberId',app.actor()::text))) OR
 (m.group_id IS NOT NULL AND app.in_group(m.group_id,app.actor()) AND NOT app.blocked(m.owner_id,app.actor()) AND m.envelope->'recipients' @> jsonb_build_array(jsonb_build_object('memberId',app.actor()::text)))
 ))
$$;
DROP POLICY media_read ON app.media_assets;
CREATE POLICY media_read ON app.media_assets FOR SELECT USING(app.can_media(id));

CREATE FUNCTION app.attach_surface_media(media uuid,kind text,target uuid,asset_slot text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE m app.media_assets; target_envelope jsonb;
BEGIN
 IF NOT app.may_write() OR kind NOT IN('profile','group') OR asset_slot NOT IN('avatar','cover','background','image') THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 PERFORM app.lock_epoch();
 IF kind='profile' THEN
  IF target<>app.actor() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  SELECT envelope INTO target_envelope FROM app.profiles WHERE member_id=target FOR UPDATE;
 ELSE
  IF NOT app.group_manager(target,app.actor()) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  SELECT envelope INTO target_envelope FROM app.groups WHERE id=target FOR UPDATE;
 END IF;
 SELECT * INTO m FROM app.media_assets WHERE id=media AND owner_id=app.actor() AND state='ready' AND num_nonnulls(post_id,profile_member_id,group_id)=0 FOR UPDATE;
 IF m.id IS NULL OR target_envelope IS NULL THEN RAISE EXCEPTION 'MEDIA_NOT_READY';END IF;
 IF m.envelope->'context'->>'parentId' IS DISTINCT FROM target::text OR m.envelope->'context'->>'audience' IS DISTINCT FROM target_envelope->'context'->>'audience' OR m.envelope->'context'->>'groupId' IS DISTINCT FROM target_envelope->'context'->>'groupId' OR m.envelope->'recipients' IS DISTINCT FROM target_envelope->'recipients' OR(app.media_deadline(media) IS NOT NULL AND app.media_deadline(media)<=now()) THEN RAISE EXCEPTION 'MEDIA_AUDIENCE_MISMATCH';END IF;
 DELETE FROM app.media_assets WHERE slot=asset_slot AND((kind='profile' AND profile_member_id=target)OR(kind='group' AND group_id=target));
 UPDATE app.media_assets SET profile_member_id=CASE WHEN kind='profile' THEN target END,group_id=CASE WHEN kind='group' THEN target END,slot=asset_slot,state='attached' WHERE id=media;
END $$;

CREATE OR REPLACE FUNCTION app.expire_batch(batch_size integer DEFAULT 200) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE p integer;c integer;m integer;BEGIN
 IF batch_size<1 OR batch_size>1000 THEN RAISE EXCEPTION 'INVALID_BATCH';END IF;
 DELETE FROM app.posts WHERE id IN(SELECT id FROM app.posts WHERE expires_at<=now() ORDER BY expires_at LIMIT batch_size FOR UPDATE SKIP LOCKED);GET DIAGNOSTICS p=ROW_COUNT;
 DELETE FROM app.comments WHERE id IN(SELECT id FROM app.comments WHERE expires_at<=now() ORDER BY expires_at LIMIT batch_size FOR UPDATE SKIP LOCKED);GET DIAGNOSTICS c=ROW_COUNT;
 DELETE FROM app.media_assets WHERE id IN(SELECT id FROM app.media_assets WHERE(state<>'attached' AND created_at<now()-interval '24 hours')OR app.media_deadline(id)<=now() LIMIT batch_size FOR UPDATE SKIP LOCKED);GET DIAGNOSTICS m=ROW_COUNT;
 UPDATE app.data_transfer_jobs SET state='invalidated' WHERE expires_at<=now() AND state IN('pending','complete');
 DELETE FROM app.reports WHERE retention_until<=now();
 RETURN jsonb_build_object('posts',p,'comments',c,'abandoned_media',m);
END $$;
REVOKE ALL ON FUNCTION app.media_deadline(uuid),app.can_media(uuid),app.attach_surface_media(uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_media(uuid),app.media_deadline(uuid),app.attach_surface_media(uuid,text,uuid,text) TO porchday_social;
