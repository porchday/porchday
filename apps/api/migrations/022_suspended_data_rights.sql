-- Ordinary enforcement cannot take away data ownership. Takeover holds remain a
-- separate, narrow exception; suspended members get own-data tools, never feeds.
CREATE FUNCTION app.may_manage_data() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT EXISTS(SELECT FROM app.members WHERE id=app.actor() AND status IN('active','restricted','suspended')) $$;
REVOKE ALL ON FUNCTION app.may_manage_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.may_manage_data() TO porchday_social;
CREATE POLICY own_backup_read ON app.encrypted_key_backups FOR SELECT USING(member_id=app.actor() AND app.may_manage_data());
CREATE POLICY own_devices_read ON app.device_keys FOR SELECT USING(member_id=app.actor() AND app.may_manage_data());
CREATE POLICY own_profile_read ON app.profiles FOR SELECT USING(member_id=app.actor() AND app.may_manage_data());
DROP POLICY transfer_self ON app.data_transfer_jobs;
CREATE POLICY transfer_self ON app.data_transfer_jobs FOR ALL USING(member_id=app.actor() AND app.may_manage_data()) WITH CHECK(member_id=app.actor() AND app.may_manage_data());
CREATE FUNCTION app.owned_groups_for_deletion() RETURNS TABLE(id uuid,envelope jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT id,envelope FROM app.groups WHERE owner_id=app.actor() AND app.may_manage_data() $$;
CREATE FUNCTION app.delete_owned_group(g uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NOT app.may_manage_data() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 DELETE FROM app.groups WHERE id=g AND owner_id=app.actor();
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
END $$;
REVOKE ALL ON FUNCTION app.owned_groups_for_deletion(),app.delete_owned_group(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.owned_groups_for_deletion(),app.delete_owned_group(uuid) TO porchday_social;

CREATE OR REPLACE FUNCTION app.export_owned() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT CASE WHEN app.may_manage_data() THEN jsonb_build_object(
 'schema_version',1,'generated_at',statement_timestamp(),
 'profile',(SELECT to_jsonb(p) FROM app.profiles p WHERE member_id=app.actor()),
 'posts',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM app.posts p WHERE author_id=app.actor() AND(expires_at IS NULL OR expires_at>statement_timestamp())),'[]'::jsonb),
 'comments',coalesce((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('effective_expires_at',app.comment_deadline(c.id))) FROM app.comments c JOIN app.posts p ON p.id=c.post_id WHERE c.author_id=app.actor() AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp()) AND(app.comment_deadline(c.id) IS NULL OR app.comment_deadline(c.id)>statement_timestamp())),'[]'::jsonb),
 'post_reactions',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM app.post_reactions r JOIN app.posts p ON p.id=r.post_id WHERE r.member_id=app.actor() AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())),'[]'::jsonb),
 'comment_reactions',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM app.comment_reactions r WHERE r.member_id=app.actor() AND(app.comment_deadline(r.comment_id) IS NULL OR app.comment_deadline(r.comment_id)>statement_timestamp())),'[]'::jsonb),
 'media',coalesce((SELECT jsonb_agg(to_jsonb(m)-'object_key') FROM app.media_assets m LEFT JOIN app.posts p ON p.id=m.post_id WHERE m.owner_id=app.actor() AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())),'[]'::jsonb),
 'connections',coalesce((SELECT jsonb_agg(jsonb_build_object('member_id',CASE WHEN member_a=app.actor() THEN member_b ELSE member_a END,'kind',kind)) FROM app.connections WHERE app.actor() IN(member_a,member_b)),'[]'::jsonb),
 'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('group_id',group_id,'role',role)) FROM app.group_memberships WHERE member_id=app.actor()),'[]'::jsonb)
 ) ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION app.delete_member() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE a uuid:=app.actor(); BEGIN
 IF NOT app.may_manage_data() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 IF EXISTS(SELECT FROM app.groups WHERE owner_id=a) THEN RAISE EXCEPTION 'OWNED_GROUPS'; END IF;
 UPDATE app.members SET status='deleting' WHERE id=a;
 INSERT INTO app.deletion_ledger(kind,object_id) VALUES('members',a) ON CONFLICT DO NOTHING;
 DELETE FROM app.members WHERE id=a;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
END $$;

CREATE OR REPLACE FUNCTION app.allow_social_request() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE n integer;b bigint:=floor(extract(epoch from now())/60);BEGIN
 IF NOT app.may_manage_data() THEN RETURN false;END IF;
 INSERT INTO app.social_rate_limits(member_id,bucket,count) VALUES(app.actor(),b,1) ON CONFLICT(member_id,bucket) DO UPDATE SET count=social_rate_limits.count+1 RETURNING count INTO n;
 DELETE FROM app.social_rate_limits WHERE member_id=app.actor() AND bucket<b-2;
 RETURN n<=120;
END $$;

CREATE OR REPLACE FUNCTION app.export_page(job uuid,section text,after_id text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.data_transfer_jobs;rows jsonb;next_id text;BEGIN
 IF NOT app.may_manage_data() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT * INTO j FROM app.data_transfer_jobs WHERE id=job AND member_id=app.actor() AND kind='export' AND state='complete' AND expires_at>statement_timestamp();
 IF j.id IS NULL THEN RAISE EXCEPTION 'EXPORT_INVALIDATED';END IF;
 IF section NOT IN('profile','posts','comments','post_reactions','comment_reactions','media','connections','groups') OR length(after_id)>256 THEN RAISE EXCEPTION 'INVALID_EXPORT_SECTION';END IF;
 WITH page AS(SELECT export_id,item||jsonb_build_object('export_id',export_id) AS item FROM app.export_items(section,j.created_at) WHERE export_id>after_id ORDER BY export_id LIMIT 26),numbered AS(SELECT *,row_number() OVER(ORDER BY export_id) AS n FROM page)
 SELECT coalesce(jsonb_agg(item ORDER BY export_id) FILTER(WHERE n<=25),'[]'::jsonb),CASE WHEN count(*)>25 THEN max(export_id) FILTER(WHERE n=25) END INTO rows,next_id FROM numbered;
 RETURN jsonb_build_object('schema_version',1,'generated_at',j.created_at,'next_cursor',next_id,section,CASE WHEN section='profile' THEN rows->0 ELSE rows END);
END $$;

CREATE OR REPLACE FUNCTION app.export_media(job uuid,media uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE result text;BEGIN
 IF NOT app.may_manage_data() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF NOT EXISTS(SELECT FROM app.data_transfer_jobs WHERE id=job AND member_id=app.actor() AND kind='export' AND state='complete' AND expires_at>statement_timestamp()) THEN RAISE EXCEPTION 'EXPORT_INVALIDATED';END IF;
 SELECT m.object_key INTO result FROM app.media_assets m JOIN app.data_transfer_jobs j ON j.id=job WHERE m.id=media AND m.owner_id=app.actor() AND m.state IN('ready','attached') AND m.created_at<=j.created_at AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp());
 IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;RETURN result;
END $$;

CREATE OR REPLACE FUNCTION app.validate_export(job uuid,refs jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.data_transfer_jobs;ref jsonb;row jsonb;section text;deadline timestamptz;BEGIN
 IF NOT app.may_manage_data() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT * INTO j FROM app.data_transfer_jobs WHERE id=job AND member_id=app.actor() AND kind='export' AND state='complete' AND expires_at>statement_timestamp();
 IF j.id IS NULL THEN RAISE EXCEPTION 'EXPORT_INVALIDATED';END IF;
 IF jsonb_typeof(refs)<>'array' OR jsonb_array_length(refs)>1000 THEN RAISE EXCEPTION 'INVALID_EXPORT_REFS';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
  section:=CASE ref->>'kind' WHEN 'profile' THEN 'profile' WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'comments' WHEN 'post_reaction' THEN 'post_reactions' WHEN 'comment_reaction' THEN 'comment_reactions' WHEN 'media' THEN 'media' END;
  IF section IS NULL THEN RETURN false;END IF;
  SELECT item INTO row FROM app.export_items(section,j.created_at) WHERE export_id=ref->>'id';
  IF row IS NULL OR(row->'envelope'->'context'->>'revision')::integer IS DISTINCT FROM(ref->>'revision')::integer THEN RETURN false;END IF;
  deadline:=least((row->>'effective_expires_at')::timestamptz,(row->>'expires_at')::timestamptz,(row->'envelope'->'context'->>'expiresAt')::timestamptz);
  IF deadline IS DISTINCT FROM(ref->>'expires_at')::timestamptz OR deadline<=statement_timestamp() THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.author_key(d uuid) RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text,revoked_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT k.id,k.member_id,k.public_key,k.fingerprint,k.revoked_at FROM app.device_keys k WHERE k.id=d AND((k.member_id=app.actor() AND app.may_manage_data()) OR(app.may_read() AND( app.connected(k.member_id,app.actor()) OR EXISTS(SELECT FROM app.posts p WHERE p.envelope->'context'->>'authorDeviceId'=d::text AND app.can_post(p.id)) OR EXISTS(SELECT FROM app.comments c WHERE c.envelope->'context'->>'authorDeviceId'=d::text AND app.can_comment(c.id)) OR EXISTS(SELECT FROM app.group_memberships a JOIN app.group_memberships b USING(group_id) WHERE a.member_id=k.member_id AND b.member_id=app.actor()))))
 UNION ALL
 SELECT (g.author_key->>'id')::uuid,(g.author_key->>'member_id')::uuid,g.author_key->>'public_key',g.author_key->>'fingerprint',NULL::timestamptz FROM app.groups g WHERE app.may_read() AND g.author_key->>'id'=d::text AND app.in_group(g.id,app.actor())
 LIMIT 1
$$;
