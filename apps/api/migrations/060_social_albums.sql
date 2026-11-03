-- Social albums are independent of group walls and posts. Names/descriptions
-- remain encrypted. Membership/role/ownership are authorization metadata.
CREATE TABLE app.albums (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 envelope jsonb NOT NULL CHECK(octet_length(envelope::text)<=524288),
 revision integer NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.album_members (
 album_id uuid NOT NULL REFERENCES app.albums(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN('read','add','admin')),
 joined_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(album_id,member_id)
);
CREATE INDEX album_members_member ON app.album_members(member_id,album_id);
ALTER TABLE app.albums ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.albums FORCE ROW LEVEL SECURITY;
ALTER TABLE app.album_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.album_members FORCE ROW LEVEL SECURITY;

CREATE FUNCTION app.album_role(a uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT am.role FROM app.album_members am JOIN app.albums a0 ON a0.id=am.album_id
 WHERE am.album_id=a AND am.member_id=app.actor() AND app.may_read()
 AND NOT app.blocked(a0.owner_id,app.actor())
$$;
CREATE FUNCTION app.can_album(a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.album_role(a) IS NOT NULL
$$;
CREATE POLICY albums_read ON app.albums FOR SELECT USING(app.can_album(id));
CREATE POLICY album_members_read ON app.album_members FOR SELECT USING(app.can_album(album_id) AND NOT app.blocked(member_id,app.actor()));
GRANT SELECT ON app.albums,app.album_members TO porchday_social;
REVOKE ALL ON app.albums,app.album_members FROM PUBLIC;

CREATE FUNCTION app.create_album(a uuid,e jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF EXISTS(SELECT FROM app.deletion_ledger WHERE kind='albums' AND object_id=a) THEN RAISE EXCEPTION 'CONTENT_DELETED';END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 IF e->'context'->>'id' IS DISTINCT FROM a::text OR e->'context'->>'authorId' IS DISTINCT FROM app.actor()::text
 OR e->'context'->>'kind' IS DISTINCT FROM 'album' OR (e->'context'->>'revision')::integer IS DISTINCT FROM 1
 THEN RAISE EXCEPTION 'ENVELOPE_CONTEXT';END IF;
 INSERT INTO app.albums(id,owner_id,envelope,revision) VALUES(a,app.actor(),e,1);
 INSERT INTO app.album_members(album_id,member_id,role) VALUES(a,app.actor(),'admin');
END $$;

-- Membership changes and metadata replacement happen in one transaction.
-- The API must validate the envelope against the proposed audience under the
-- directory lock before calling this operation; SQL independently checks roles.
CREATE FUNCTION app.change_album_member(a uuid,m uuid,new_role text,e jsonb,expected_revision integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE current_album app.albums; actor_role text;
BEGIN
 IF NOT app.may_write() OR (new_role IS NOT NULL AND new_role NOT IN('read','add','admin')) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 SELECT * INTO current_album FROM app.albums WHERE id=a FOR UPDATE;
 actor_role:=app.album_role(a);
 IF current_album.id IS NULL OR actor_role IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF actor_role<>'admin' THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF current_album.revision<>expected_revision THEN RAISE EXCEPTION 'REVISION_CHANGED';END IF;
 IF m=current_album.owner_id AND new_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'ALBUM_OWNER_REQUIRED';END IF;
 IF new_role IS NOT NULL AND (app.blocked(m,app.actor()) OR app.blocked(m,current_album.owner_id)
 OR NOT EXISTS(SELECT FROM app.members WHERE id=m AND status IN('active','restricted')))
 THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE';END IF;
 IF new_role IS NOT NULL AND NOT EXISTS(SELECT FROM app.album_members WHERE album_id=a AND member_id=m)
 AND (SELECT count(*) FROM app.album_members WHERE album_id=a)>=300 THEN RAISE EXCEPTION 'ALBUM_MEMBER_LIMIT';END IF;
 IF e->'context'->>'id' IS DISTINCT FROM a::text OR e->'context'->>'authorId' IS DISTINCT FROM app.actor()::text
 OR e->'context'->>'kind' IS DISTINCT FROM 'album' OR (e->'context'->>'revision')::integer IS DISTINCT FROM expected_revision+1
 THEN RAISE EXCEPTION 'ENVELOPE_CONTEXT';END IF;
 IF new_role IS NULL THEN DELETE FROM app.album_members WHERE album_id=a AND member_id=m;
 ELSE INSERT INTO app.album_members(album_id,member_id,role) VALUES(a,m,new_role) ON CONFLICT(album_id,member_id) DO UPDATE SET role=excluded.role;END IF;
 UPDATE app.albums SET envelope=e,revision=expected_revision+1 WHERE id=a;
END $$;
CREATE FUNCTION app.leave_album(a uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 IF EXISTS(SELECT FROM app.albums WHERE id=a AND owner_id=app.actor()) THEN RAISE EXCEPTION 'ALBUM_OWNER_REQUIRED';END IF;
 DELETE FROM app.album_members WHERE album_id=a AND member_id=app.actor();
END $$;
CREATE FUNCTION app.transfer_album(a uuid,new_owner uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 IF NOT EXISTS(SELECT FROM app.albums WHERE id=a AND owner_id=app.actor()) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF NOT EXISTS(SELECT FROM app.album_members am JOIN app.members m ON m.id=am.member_id WHERE am.album_id=a AND am.member_id=new_owner AND am.role='admin' AND m.status='active') OR app.blocked(new_owner,app.actor()) THEN RAISE EXCEPTION 'ALBUM_ADMIN_REQUIRED';END IF;
 UPDATE app.albums SET owner_id=new_owner WHERE id=a;
END $$;
CREATE FUNCTION app.delete_album(a uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 IF NOT EXISTS(SELECT FROM app.albums WHERE id=a AND owner_id=app.actor()) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 DELETE FROM app.albums WHERE id=a;
END $$;

CREATE FUNCTION app.journal_album() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF TG_TABLE_NAME='album_members' THEN
  IF TG_OP='DELETE' THEN PERFORM app.append_safety_decision(jsonb_build_object('action','album_member_remove','album',OLD.album_id,'member',OLD.member_id));
  ELSIF NEW.role IS DISTINCT FROM OLD.role AND array_position(ARRAY['read','add','admin'],NEW.role)<array_position(ARRAY['read','add','admin'],OLD.role) THEN
   PERFORM app.append_safety_decision(jsonb_build_object('action','album_role','album',NEW.album_id,'member',NEW.member_id,'role',NEW.role));
  END IF;
 ELSE
  IF TG_OP='DELETE' THEN INSERT INTO app.deletion_ledger(kind,object_id) VALUES('albums',OLD.id) ON CONFLICT DO NOTHING;
  ELSE
   IF NEW.owner_id<>OLD.owner_id THEN PERFORM app.append_safety_decision(jsonb_build_object('action','album_owner','id',NEW.id,'owner',NEW.owner_id));END IF;
   IF NEW.envelope IS DISTINCT FROM OLD.envelope THEN PERFORM app.append_safety_decision(jsonb_build_object('action','revision','kind','albums','id',NEW.id,'revision',NEW.revision));END IF;
  END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER journal_album AFTER UPDATE OR DELETE ON app.albums FOR EACH ROW EXECUTE FUNCTION app.journal_album();
CREATE TRIGGER journal_album_member AFTER UPDATE OR DELETE ON app.album_members FOR EACH ROW EXECUTE FUNCTION app.journal_album();

-- Preserve the installed restore reader (including staging-specific markers).
DO $migration$
DECLARE definition text; old_fragment text; new_fragment text; replacements text[][];
BEGIN
 SELECT pg_get_functiondef('app.replay_safety_batch(jsonb)'::regprocedure) INTO definition;
 replacements:=ARRAY[
  ARRAY[$old$kind IN('posts','comments','groups','media_assets','child_profiles')$old$,$new$kind IN('posts','comments','groups','media_assets','child_profiles','albums')$new$],
  ARRAY[$old$ELSIF kind='emoji_libraries' THEN$old$,$new$ELSIF kind='albums' THEN UPDATE app.albums SET envelope='{}',revision=(d->>'revision')::integer WHERE id=(d->>'id')::uuid AND revision<(d->>'revision')::integer;
   ELSIF kind='emoji_libraries' THEN$new$],
  ARRAY[$old$WHEN 'connection' THEN$old$,$new$WHEN 'album_member_remove' THEN DELETE FROM app.album_members WHERE album_id=(d->>'album')::uuid AND member_id=(d->>'member')::uuid;
  WHEN 'album_role' THEN
   IF d->>'role' NOT IN('read','add','admin') THEN RAISE EXCEPTION 'INVALID_ALBUM_ROLE';END IF;
   UPDATE app.album_members SET role=d->>'role' WHERE album_id=(d->>'album')::uuid AND member_id=(d->>'member')::uuid AND array_position(ARRAY['read','add','admin'],role)>array_position(ARRAY['read','add','admin'],d->>'role');
  WHEN 'album_owner' THEN
   IF EXISTS(SELECT FROM app.albums WHERE id=(d->>'id')::uuid) AND NOT EXISTS(SELECT FROM app.album_members WHERE album_id=(d->>'id')::uuid AND member_id=(d->>'owner')::uuid AND role='admin') THEN RAISE EXCEPTION 'RESTORE_OWNER_MISSING';END IF;
   UPDATE app.albums SET owner_id=(d->>'owner')::uuid WHERE id=(d->>'id')::uuid;
  WHEN 'connection' THEN$new$],
  ARRAY[$old$DELETE FROM app.groups WHERE owner_id=object;DELETE FROM app.members WHERE id=object;$old$,$new$DELETE FROM app.albums WHERE owner_id=object;DELETE FROM app.groups WHERE owner_id=object;DELETE FROM app.members WHERE id=object;$new$]
 ];
 FOR i IN 1..array_length(replacements,1) LOOP
  old_fragment:=replacements[i][1];new_fragment:=replacements[i][2];
  IF (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 THEN RAISE EXCEPTION 'UNRECOGNIZED_RESTORE_READER';END IF;
  definition:=replace(definition,old_fragment,new_fragment);
 END LOOP;
 EXECUTE definition;
END $migration$;
REVOKE ALL ON FUNCTION app.album_role(uuid),app.can_album(uuid),app.create_album(uuid,jsonb),app.change_album_member(uuid,uuid,text,jsonb,integer),app.leave_album(uuid),app.transfer_album(uuid,uuid),app.delete_album(uuid),app.journal_album() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.album_role(uuid),app.can_album(uuid),app.create_album(uuid,jsonb),app.change_album_member(uuid,uuid,text,jsonb,integer),app.leave_album(uuid),app.transfer_album(uuid,uuid),app.delete_album(uuid) TO porchday_social;

-- The caller serializes prospective-recipient validation and mutation using this
-- lock before taking row locks. Read-only snapshots use the ordinary shared lock.
CREATE FUNCTION app.lock_album_directory() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE result bigint;
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT epoch INTO result FROM app.directory_epoch WHERE id FOR UPDATE;
 RETURN result;
END $$;
CREATE FUNCTION app.album_audience_members(a uuid,changed_member uuid DEFAULT NULL,changed_role text DEFAULT NULL)
RETURNS TABLE(member_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE actor_role text; album_owner uuid;
BEGIN
 actor_role:=app.album_role(a);
 IF actor_role IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF changed_member IS NOT NULL AND (actor_role<>'admin' OR NOT app.may_write()) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF changed_role IS NOT NULL AND (changed_member IS NULL OR changed_role NOT IN('read','add','admin')) THEN RAISE EXCEPTION 'INVALID_ALBUM_ROLE';END IF;
 SELECT owner_id INTO album_owner FROM app.albums WHERE id=a;
 IF changed_member=album_owner AND changed_role IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'ALBUM_OWNER_REQUIRED';END IF;
 IF changed_role IS NOT NULL AND (app.blocked(changed_member,app.actor()) OR app.blocked(changed_member,album_owner)
 OR NOT EXISTS(SELECT FROM app.members WHERE id=changed_member AND status IN('active','restricted'))) THEN RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE';END IF;
 -- A blocked participant is not silently omitted from a proposed full snapshot.
 -- The administrator must remove that participant before redistributing metadata.
 IF EXISTS(SELECT FROM app.album_members am WHERE am.album_id=a AND am.member_id IS DISTINCT FROM changed_member AND (app.blocked(am.member_id,app.actor()) OR app.blocked(am.member_id,album_owner))) THEN RAISE EXCEPTION 'ALBUM_AUDIENCE_BLOCKED';END IF;
 RETURN QUERY SELECT m.id FROM app.members m WHERE m.status IN('active','restricted') AND (
  EXISTS(SELECT FROM app.album_members am WHERE am.album_id=a AND am.member_id=m.id AND am.member_id IS DISTINCT FROM changed_member)
  OR (changed_role IS NOT NULL AND m.id=changed_member)
 ) ORDER BY m.id;
END $$;
CREATE FUNCTION app.album_audience_devices(a uuid,changed_member uuid DEFAULT NULL,changed_role text DEFAULT NULL)
RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT d.id,d.member_id,d.public_key,d.fingerprint FROM app.device_keys d JOIN app.album_audience_members(a,changed_member,changed_role) m ON m.member_id=d.member_id
 WHERE d.revoked_at IS NULL ORDER BY d.id
$$;
REVOKE ALL ON FUNCTION app.lock_album_directory(),app.album_audience_members(uuid,uuid,text),app.album_audience_devices(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_album_directory(),app.album_audience_members(uuid,uuid,text),app.album_audience_devices(uuid,uuid,text) TO porchday_social;

-- Keep the public signature-verification key when the metadata author later
-- leaves or deletes their account, just as group metadata already does.
ALTER TABLE app.albums ADD COLUMN author_key jsonb;
CREATE FUNCTION app.bind_album_author() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.envelope='{}'::jsonb AND current_setting('app.restore_replay',true)='on' THEN RETURN NEW;END IF;
 SELECT jsonb_build_object('id',d.id,'member_id',d.member_id,'public_key',d.public_key,'fingerprint',d.fingerprint) INTO NEW.author_key
 FROM app.device_keys d WHERE d.id=(NEW.envelope->'context'->>'authorDeviceId')::uuid AND d.member_id=(NEW.envelope->'context'->>'authorId')::uuid AND d.revoked_at IS NULL;
 IF NEW.author_key IS NULL THEN RAISE EXCEPTION 'ALBUM_AUTHOR_KEY_REQUIRED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_album_author BEFORE INSERT OR UPDATE OF envelope ON app.albums FOR EACH ROW EXECUTE FUNCTION app.bind_album_author();
CREATE FUNCTION app.album_member_details(a uuid) RETURNS TABLE(member_id uuid,role text,handle text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT am.member_id,am.role,p.handle FROM app.album_members am JOIN app.profiles p ON p.member_id=am.member_id
 WHERE am.album_id=a AND app.can_album(a) AND NOT app.blocked(am.member_id,app.actor()) ORDER BY p.handle,am.member_id
$$;
CREATE FUNCTION app.edit_album(a uuid,e jsonb,expected_revision integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE current_album app.albums;
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 SELECT * INTO current_album FROM app.albums WHERE id=a FOR UPDATE;
 IF current_album.id IS NULL OR app.album_role(a) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF current_album.revision<>expected_revision THEN RAISE EXCEPTION 'REVISION_CHANGED';END IF;
 IF e->'context'->>'id' IS DISTINCT FROM a::text OR e->'context'->>'authorId' IS DISTINCT FROM app.actor()::text
 OR e->'context'->>'kind' IS DISTINCT FROM 'album' OR (e->'context'->>'revision')::integer IS DISTINCT FROM expected_revision+1 THEN RAISE EXCEPTION 'ENVELOPE_CONTEXT';END IF;
 UPDATE app.albums SET envelope=e,revision=expected_revision+1 WHERE id=a;
END $$;
REVOKE ALL ON FUNCTION app.bind_album_author(),app.album_member_details(uuid),app.edit_album(uuid,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.album_member_details(uuid),app.edit_album(uuid,jsonb,integer) TO porchday_social;
