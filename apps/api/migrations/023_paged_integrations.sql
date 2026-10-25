CREATE FUNCTION app.integration_page(token_hash text,requested_scope text,section text,after_id text DEFAULT '',snapshot_at timestamptz DEFAULT statement_timestamp()) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE g app.integration_grants;rows jsonb;next_id text;BEGIN
 SELECT ig.* INTO g FROM app.integration_grants ig JOIN app.members m ON m.id=ig.member_id WHERE ig.access_hash=token_hash AND requested_scope=ANY(ig.scopes) AND ig.access_expires_at>now() AND ig.expires_at>now() AND ig.revoked_at IS NULL AND m.status IN('active','restricted');
 IF g.id IS NULL THEN RAISE EXCEPTION 'INVALID_GRANT';END IF;
 IF length(after_id)>256 OR snapshot_at>statement_timestamp()+interval '1 second' OR NOT((requested_scope='profile:read' AND section='profile') OR(requested_scope='content:read' AND section IN('posts','comments','post_reactions','comment_reactions')) OR(requested_scope='media:read' AND section='media') OR(requested_scope='export:read' AND section='jobs')) THEN RAISE EXCEPTION 'INVALID_GRANT';END IF;
 PERFORM set_config('app.member_id',g.member_id::text,true);
 IF section='jobs' THEN
  WITH page AS(SELECT id::text export_id,to_jsonb(j) item FROM app.data_transfer_jobs j WHERE member_id=g.member_id AND kind='export' AND created_at<=snapshot_at AND id::text>after_id ORDER BY id::text LIMIT 26),numbered AS(SELECT *,row_number() OVER(ORDER BY export_id) n FROM page)
  SELECT coalesce(jsonb_agg(item ORDER BY export_id) FILTER(WHERE n<=25),'[]'::jsonb),CASE WHEN count(*)>25 THEN max(export_id) FILTER(WHERE n=25) END INTO rows,next_id FROM numbered;
 ELSE
  WITH page AS(SELECT export_id,item FROM app.export_items(section,snapshot_at) WHERE export_id>after_id ORDER BY export_id LIMIT 26),numbered AS(SELECT *,row_number() OVER(ORDER BY export_id) n FROM page)
  SELECT coalesce(jsonb_agg(item ORDER BY export_id) FILTER(WHERE n<=25),'[]'::jsonb),CASE WHEN count(*)>25 THEN max(export_id) FILTER(WHERE n=25) END INTO rows,next_id FROM numbered;
 END IF;
 UPDATE app.integration_grants SET last_used_at=now() WHERE id=g.id;
 RETURN jsonb_build_object(section,CASE WHEN section='profile' THEN rows->0 ELSE rows END,'next_id',next_id,'snapshot_at',snapshot_at);
END $$;
REVOKE ALL ON FUNCTION app.integration_page(text,text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.integration_page(text,text,text,text,timestamptz) TO porchday_social;
-- The prior aggregate helper remains private for migration compatibility; no
-- runtime caller can accidentally return an unbounded ciphertext collection.
REVOKE EXECUTE ON FUNCTION app.integration_read(text,text) FROM porchday_social;
