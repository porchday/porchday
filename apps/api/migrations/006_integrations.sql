ALTER TABLE app.integration_clients ADD COLUMN purpose text NOT NULL DEFAULT 'Member-authorized ciphertext export' CHECK(length(purpose)<=500);
CREATE FUNCTION app.exchange_integration_code(client uuid,redirect text,code text,challenge text,access_token_hash text,refresh_token_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE g app.integration_grants;
BEGIN
 SELECT ig.* INTO g FROM app.integration_grants ig JOIN app.integration_clients ic ON ic.id=ig.client_id JOIN app.members m ON m.id=ig.member_id WHERE ig.client_id=client AND ic.redirect_uri=redirect AND ig.code_hash=code AND ig.code_challenge=challenge AND ig.code_expires_at>now() AND ig.revoked_at IS NULL AND ig.expires_at>now() AND m.status IN('active','restricted') FOR UPDATE OF ig;
 IF g.id IS NULL THEN RAISE EXCEPTION 'INVALID_GRANT'; END IF;
 UPDATE app.integration_grants SET code_hash=NULL,access_hash=access_token_hash,refresh_hash=refresh_token_hash,access_expires_at=now()+interval '10 minutes',last_used_at=now() WHERE id=g.id;
 RETURN jsonb_build_object('scope',array_to_string(g.scopes,' '),'expires_in',600);
END $$;
CREATE FUNCTION app.refresh_integration(client uuid,old_refresh text,access_token_hash text,new_refresh text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE g app.integration_grants;
BEGIN
 SELECT ig.* INTO g FROM app.integration_grants ig JOIN app.members m ON m.id=ig.member_id WHERE ig.client_id=client AND ig.refresh_hash=old_refresh AND ig.revoked_at IS NULL AND ig.expires_at>now() AND m.status IN('active','restricted') FOR UPDATE OF ig;
 IF g.id IS NULL THEN RAISE EXCEPTION 'INVALID_GRANT'; END IF;
 UPDATE app.integration_grants SET access_hash=access_token_hash,refresh_hash=new_refresh,access_expires_at=now()+interval '10 minutes',last_used_at=now() WHERE id=g.id;
 RETURN jsonb_build_object('scope',array_to_string(g.scopes,' '),'expires_in',600);
END $$;
CREATE FUNCTION app.integration_read(token_hash text,scope text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE g app.integration_grants; archive jsonb;
BEGIN
 SELECT ig.* INTO g FROM app.integration_grants ig JOIN app.members m ON m.id=ig.member_id WHERE ig.access_hash=token_hash AND scope=ANY(ig.scopes) AND ig.access_expires_at>now() AND ig.expires_at>now() AND ig.revoked_at IS NULL AND m.status IN('active','restricted');
 IF g.id IS NULL THEN RAISE EXCEPTION 'INVALID_GRANT'; END IF;
 PERFORM set_config('app.member_id',g.member_id::text,true);
 archive:=app.export_owned();
 UPDATE app.integration_grants SET last_used_at=now() WHERE id=g.id;
 RETURN CASE scope WHEN 'profile:read' THEN jsonb_build_object('profile',archive->'profile') WHEN 'content:read' THEN jsonb_build_object('posts',archive->'posts','comments',archive->'comments','post_reactions',archive->'post_reactions','comment_reactions',archive->'comment_reactions') WHEN 'media:read' THEN jsonb_build_object('media',archive->'media') WHEN 'export:read' THEN jsonb_build_object('jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j)),'[]'::jsonb) FROM app.data_transfer_jobs j WHERE member_id=g.member_id AND kind='export')) ELSE NULL END;
END $$;
CREATE FUNCTION app.integration_media(token_hash text,media uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE result text;
BEGIN
 SELECT m.object_key INTO result FROM app.integration_grants ig JOIN app.members u ON u.id=ig.member_id JOIN app.media_assets m ON m.owner_id=ig.member_id LEFT JOIN app.posts p ON p.id=m.post_id WHERE m.id=media AND m.state IN('ready','attached') AND(p.expires_at IS NULL OR p.expires_at>now()) AND ig.access_hash=token_hash AND 'media:read'=ANY(ig.scopes) AND ig.access_expires_at>now() AND ig.expires_at>now() AND ig.revoked_at IS NULL AND u.status IN('active','restricted');
 IF result IS NULL THEN RAISE EXCEPTION 'INVALID_GRANT'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.exchange_integration_code(uuid,text,text,text,text,text),app.refresh_integration(uuid,text,text,text),app.integration_read(text,text),app.integration_media(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.exchange_integration_code(uuid,text,text,text,text,text),app.refresh_integration(uuid,text,text,text),app.integration_read(text,text),app.integration_media(text,uuid) TO porchday_social;
