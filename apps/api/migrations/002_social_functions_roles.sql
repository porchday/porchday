DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_social') THEN CREATE ROLE porchday_social NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_auth') THEN CREATE ROLE porchday_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_jobs') THEN CREATE ROLE porchday_jobs NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
END $$;
CREATE FUNCTION app.auth_provision_member(member uuid,new_handle text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 INSERT INTO app.members(id,adult_attested_at,rules_accepted_at) VALUES(member,now(),now()) ON CONFLICT DO NOTHING;
 INSERT INTO app.profiles(member_id,handle) VALUES(member,new_handle) ON CONFLICT(member_id) DO NOTHING;
END $$;
CREATE FUNCTION app.auth_member_status(member uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT status FROM app.members WHERE id=member $$;
CREATE FUNCTION app.set_security_hold(member uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 UPDATE app.members SET status='hold' WHERE id=member;
 UPDATE app.integration_grants SET revoked_at=now(),access_hash=NULL,refresh_hash=NULL,code_hash=NULL WHERE member_id=member;
 UPDATE app.data_transfer_jobs SET state='invalidated' WHERE member_id=member;
END $$;
CREATE FUNCTION app.lookup_handle(h text) RETURNS TABLE(id uuid,handle text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT p.member_id,p.handle FROM app.profiles p JOIN app.members m ON m.id=p.member_id WHERE p.handle=h AND app.may_read() AND m.status IN('active','restricted') AND NOT app.blocked(p.member_id,app.actor())
$$;
CREATE FUNCTION app.member_handles(ids uuid[]) RETURNS TABLE(id uuid,handle text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT p.member_id,p.handle FROM app.profiles p WHERE p.member_id=ANY(ids) AND app.may_read() AND NOT app.blocked(p.member_id,app.actor()) AND(p.member_id=app.actor() OR app.connected(p.member_id,app.actor()) OR EXISTS(SELECT FROM app.group_memberships a JOIN app.group_memberships b USING(group_id) WHERE a.member_id=app.actor() AND b.member_id=p.member_id) OR EXISTS(SELECT FROM app.connection_requests WHERE app.actor() IN(sender,recipient) AND p.member_id IN(sender,recipient)))
$$;
CREATE FUNCTION app.bump_epoch() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE result bigint; BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id RETURNING epoch INTO result; RETURN result;
END $$;
CREATE FUNCTION app.audience_devices(audience text,g uuid DEFAULT NULL,p uuid DEFAULT NULL) RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF p IS NOT NULL AND NOT app.can_post(p) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF audience='group' AND NOT app.in_group(g,app.actor()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN QUERY SELECT d.id,d.member_id,d.public_key,d.fingerprint FROM app.device_keys d JOIN app.members m ON m.id=d.member_id WHERE d.revoked_at IS NULL AND m.status IN('active','restricted') AND NOT app.blocked(d.member_id,app.actor()) AND (
  CASE WHEN p IS NOT NULL THEN EXISTS(SELECT FROM app.post_recipients pr JOIN app.posts p0 ON p0.id=pr.post_id WHERE pr.post_id=p AND pr.device_id=d.id AND NOT app.blocked(d.member_id,p0.author_id) AND (d.member_id=p0.author_id OR (p0.audience='connections' AND app.connected(p0.author_id,d.member_id)) OR(p0.audience='family' AND app.connected(p0.author_id,d.member_id,true)) OR(p0.audience='group' AND app.in_group(p0.group_id,d.member_id))))
  ELSE d.member_id=app.actor() OR(audience='connections' AND app.connected(app.actor(),d.member_id)) OR(audience='family' AND app.connected(app.actor(),d.member_id,true)) OR(audience='group' AND app.in_group(g,d.member_id)) END
 ) ORDER BY d.id;
END $$;
CREATE FUNCTION app.create_group(g uuid,body jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 IF (SELECT count(*) FROM app.groups WHERE owner_id=app.actor())>=30 THEN RAISE EXCEPTION 'GROUP_LIMIT'; END IF;
 INSERT INTO app.groups(id,owner_id,envelope) VALUES(g,app.actor(),body);
 INSERT INTO app.group_memberships(group_id,member_id,role) VALUES(g,app.actor(),'owner');
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
END $$;
CREATE FUNCTION app.accept_group_invitation(inv uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE r app.group_invitations; BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 SELECT * INTO r FROM app.group_invitations WHERE id=inv FOR UPDATE;
 IF r.id IS NULL OR r.recipient<>app.actor() OR r.expires_at<=now() OR app.blocked(r.inviter,app.actor()) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 INSERT INTO app.group_memberships(group_id,member_id,role) VALUES(r.group_id,app.actor(),'member') ON CONFLICT DO NOTHING;
 UPDATE app.group_invitations SET accepted_at=now() WHERE id=inv;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 RETURN r.group_id;
END $$;
CREATE FUNCTION app.change_group_member(g uuid,m uuid,new_role text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE owner uuid; actor_role text; BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 SELECT owner_id INTO owner FROM app.groups WHERE id=g FOR UPDATE;
 SELECT role INTO actor_role FROM app.group_memberships WHERE group_id=g AND member_id=app.actor();
 IF owner IS NULL OR actor_role IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF new_role='remove' THEN
  IF m=owner THEN RAISE EXCEPTION 'TRANSFER_REQUIRED'; END IF;
  IF m<>app.actor() AND actor_role NOT IN('owner','moderator') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF actor_role='moderator' AND EXISTS(SELECT FROM app.group_memberships WHERE group_id=g AND member_id=m AND role='moderator') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  DELETE FROM app.group_memberships WHERE group_id=g AND member_id=m;
 ELSIF new_role IN('moderator','member') THEN
  IF owner<>app.actor() OR m=owner THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  UPDATE app.group_memberships SET role=new_role WHERE group_id=g AND member_id=m;
 ELSIF new_role='owner' THEN
  IF owner<>app.actor() OR NOT app.in_group(g,m) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  UPDATE app.groups SET owner_id=m WHERE id=g;
  UPDATE app.group_memberships SET role=CASE WHEN member_id=m THEN 'owner' ELSE 'moderator' END WHERE group_id=g AND member_id IN(owner,m);
 ELSE RAISE EXCEPTION 'INVALID_ROLE'; END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
END $$;
CREATE FUNCTION app.notify(target uuid,category text,p uuid DEFAULT NULL,c uuid DEFAULT NULL,g uuid DEFAULT NULL,dedupe text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NOT app.may_write() OR target=app.actor() OR app.blocked(target,app.actor()) THEN RETURN; END IF;
 IF category NOT IN('comment','reaction','group_invitation','connection_request') THEN RAISE EXCEPTION 'INVALID_NOTIFICATION'; END IF;
 IF p IS NOT NULL AND NOT app.can_post(p) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 INSERT INTO app.notifications(recipient,actor,kind,post_id,comment_id,group_id,dedupe_key) VALUES(target,app.actor(),category,p,c,g,dedupe) ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION app.export_owned() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT CASE WHEN app.may_read() THEN jsonb_build_object(
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
CREATE FUNCTION app.delete_member() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE a uuid:=app.actor(); BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 IF EXISTS(SELECT FROM app.groups WHERE owner_id=a) THEN RAISE EXCEPTION 'OWNED_GROUPS'; END IF;
 UPDATE app.members SET status='deleting' WHERE id=a;
 INSERT INTO app.deletion_ledger(kind,object_id) VALUES('members',a) ON CONFLICT DO NOTHING;
 DELETE FROM app.members WHERE id=a;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
END $$;
CREATE FUNCTION app.expire_batch(batch_size integer DEFAULT 200) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE p integer; c integer; m integer; BEGIN
 IF batch_size<1 OR batch_size>1000 THEN RAISE EXCEPTION 'INVALID_BATCH'; END IF;
 DELETE FROM app.posts WHERE id IN(SELECT id FROM app.posts WHERE expires_at<=now() ORDER BY expires_at LIMIT batch_size FOR UPDATE SKIP LOCKED); GET DIAGNOSTICS p=ROW_COUNT;
 DELETE FROM app.comments WHERE id IN(SELECT id FROM app.comments WHERE expires_at<=now() ORDER BY expires_at LIMIT batch_size FOR UPDATE SKIP LOCKED); GET DIAGNOSTICS c=ROW_COUNT;
 DELETE FROM app.media_assets WHERE id IN(SELECT id FROM app.media_assets WHERE post_id IS NULL AND created_at<now()-interval '24 hours' LIMIT batch_size FOR UPDATE SKIP LOCKED); GET DIAGNOSTICS m=ROW_COUNT;
 UPDATE app.data_transfer_jobs SET state='invalidated' WHERE expires_at<=now() AND state IN('pending','complete');
 DELETE FROM app.reports WHERE retention_until<=now();
 RETURN jsonb_build_object('posts',p,'comments',c,'abandoned_media',m);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO porchday_social,porchday_auth,porchday_jobs;
GRANT SELECT ON app.members,app.profiles,app.device_keys,app.encrypted_key_backups,app.connection_requests,app.connections,app.blocks,app.mutes,app.groups,app.group_memberships,app.group_invitations,app.posts,app.post_recipients,app.comments,app.post_reactions,app.comment_reactions,app.media_assets,app.notifications,app.reports,app.integration_clients,app.integration_grants,app.data_transfer_jobs,app.directory_epoch TO porchday_social;
GRANT INSERT,UPDATE,DELETE ON app.device_keys,app.encrypted_key_backups,app.mutes,app.posts,app.comments,app.post_reactions,app.comment_reactions,app.media_assets,app.integration_clients,app.integration_grants,app.data_transfer_jobs TO porchday_social;
GRANT INSERT ON app.connection_requests,app.group_invitations,app.post_recipients,app.reports TO porchday_social;
GRANT UPDATE(state) ON app.connection_requests TO porchday_social;
GRANT UPDATE(envelope,updated_at) ON app.profiles TO porchday_social;
GRANT UPDATE(notification_preferences) ON app.members TO porchday_social;
GRANT UPDATE(read_at) ON app.notifications TO porchday_social;
GRANT UPDATE(envelope) ON app.groups TO porchday_social;
GRANT DELETE ON app.groups TO porchday_social;
GRANT UPDATE(epoch) ON app.directory_epoch TO porchday_social;
GRANT EXECUTE ON FUNCTION app.actor(),app.may_read(),app.may_write(),app.blocked(uuid,uuid),app.connected(uuid,uuid,boolean),app.in_group(uuid,uuid),app.group_manager(uuid,uuid),app.can_profile(uuid),app.can_post(uuid),app.comment_deadline(uuid),app.can_comment(uuid),app.can_delete_post(uuid),app.can_delete_comment(uuid),app.accept_connection(uuid),app.change_connection(uuid,text,boolean),app.set_block(uuid,boolean),app.lookup_handle(text),app.member_handles(uuid[]),app.bump_epoch(),app.audience_devices(text,uuid,uuid),app.create_group(uuid,jsonb),app.accept_group_invitation(uuid),app.change_group_member(uuid,uuid,text),app.notify(uuid,text,uuid,uuid,uuid,text),app.export_owned(),app.delete_member() TO porchday_social;
GRANT EXECUTE ON FUNCTION app.auth_provision_member(uuid,text),app.auth_member_status(uuid),app.set_security_hold(uuid) TO porchday_auth;
GRANT EXECUTE ON FUNCTION app.expire_batch(integer) TO porchday_jobs;
GRANT SELECT,UPDATE ON app.deletion_outbox TO porchday_jobs;
CREATE POLICY jobs_outbox ON app.deletion_outbox TO porchday_jobs USING(true) WITH CHECK(true);
