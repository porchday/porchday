-- A transferred group's encrypted metadata may remain signed by its former owner.
-- Keep that public verification key with the group, so deleting the former owner's
-- account cannot break the remaining members' group name/theme verification.
ALTER TABLE app.groups ADD COLUMN author_key jsonb;
CREATE FUNCTION app.bind_group_author() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 SELECT jsonb_build_object('id',d.id,'member_id',d.member_id,'public_key',d.public_key,'fingerprint',d.fingerprint) INTO NEW.author_key FROM app.device_keys d WHERE d.id=(NEW.envelope->'context'->>'authorDeviceId')::uuid AND d.member_id=(NEW.envelope->'context'->>'authorId')::uuid AND d.revoked_at IS NULL;
 IF NEW.author_key IS NULL THEN RAISE EXCEPTION 'GROUP_AUTHOR_KEY_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_group_author BEFORE INSERT OR UPDATE OF envelope ON app.groups FOR EACH ROW EXECUTE FUNCTION app.bind_group_author();
CREATE OR REPLACE FUNCTION app.author_key(d uuid) RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text,revoked_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT k.id,k.member_id,k.public_key,k.fingerprint,k.revoked_at FROM app.device_keys k WHERE k.id=d AND app.may_read() AND(k.member_id=app.actor() OR app.connected(k.member_id,app.actor()) OR EXISTS(SELECT FROM app.posts p WHERE p.envelope->'context'->>'authorDeviceId'=d::text AND app.can_post(p.id)) OR EXISTS(SELECT FROM app.comments c WHERE c.envelope->'context'->>'authorDeviceId'=d::text AND app.can_comment(c.id)) OR EXISTS(SELECT FROM app.group_memberships a JOIN app.group_memberships b USING(group_id) WHERE a.member_id=k.member_id AND b.member_id=app.actor()))
 UNION ALL
 SELECT (g.author_key->>'id')::uuid,(g.author_key->>'member_id')::uuid,g.author_key->>'public_key',g.author_key->>'fingerprint',NULL::timestamptz FROM app.groups g WHERE app.may_read() AND g.author_key->>'id'=d::text AND app.in_group(g.id,app.actor())
 LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.bind_group_author() FROM PUBLIC;
