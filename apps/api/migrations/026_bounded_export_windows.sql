-- Keep LIMIT and cursor predicates inside the security-definer boundary. The
-- original set-returning helper could materialize all owned rows before paging.
CREATE INDEX export_posts_key ON app.posts(author_id,(id::text));
CREATE INDEX export_comments_key ON app.comments(author_id,(id::text));
CREATE INDEX export_media_key ON app.media_assets(owner_id,(id::text));
CREATE INDEX export_post_reactions_key ON app.post_reactions(member_id,(post_id::text||':'||reaction_tag));
CREATE INDEX export_comment_reactions_key ON app.comment_reactions(member_id,(comment_id::text||':'||reaction_tag));
CREATE FUNCTION app.export_window(section text,snapshot_at timestamptz,after_id text,take_count integer,exact_id text) RETURNS TABLE(export_id text,item jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT owned.export_id,owned.item FROM (
 SELECT p.member_id::text,to_jsonb(p) FROM app.profiles p WHERE section='profile' AND p.member_id=app.actor()
 UNION ALL SELECT p.id::text,to_jsonb(p) FROM app.posts p WHERE section='posts' AND p.author_id=app.actor() AND p.stored_at<=snapshot_at AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())
 UNION ALL SELECT c.id::text,to_jsonb(c)||jsonb_build_object('effective_expires_at',app.comment_deadline(c.id)) FROM app.comments c WHERE section='comments' AND c.author_id=app.actor() AND c.stored_at<=snapshot_at AND(app.comment_deadline(c.id) IS NULL OR app.comment_deadline(c.id)>statement_timestamp())
 UNION ALL SELECT r.post_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.post_reactions r JOIN app.posts p ON p.id=r.post_id WHERE section='post_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT r.comment_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.comment_reactions r WHERE section='comment_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT m.id::text,(to_jsonb(m)-'object_key')||jsonb_build_object('effective_expires_at',app.media_deadline(m.id)) FROM app.media_assets m WHERE section='media' AND m.owner_id=app.actor() AND m.state IN('ready','attached') AND m.created_at<=snapshot_at AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp())
 UNION ALL SELECT (CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END)::text,jsonb_build_object('member_id',CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END,'kind',c.kind) FROM app.connections c WHERE section='connections' AND app.actor() IN(c.member_a,c.member_b) AND c.accepted_at<=snapshot_at
 UNION ALL SELECT g.group_id::text,jsonb_build_object('group_id',g.group_id,'role',g.role) FROM app.group_memberships g WHERE section='groups' AND g.member_id=app.actor() AND g.joined_at<=snapshot_at
 ) owned(export_id,item) WHERE CASE WHEN exact_id IS NULL THEN owned.export_id>after_id ELSE owned.export_id=exact_id END
 ORDER BY owned.export_id LIMIT least(greatest(take_count,1),26)
$$;
REVOKE ALL ON FUNCTION app.export_window(text,timestamptz,text,integer,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.export_page(job uuid,section text,after_id text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.data_transfer_jobs;rows jsonb;next_id text;BEGIN
 IF NOT app.may_manage_data() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT * INTO j FROM app.data_transfer_jobs WHERE id=job AND member_id=app.actor() AND kind='export' AND state='complete' AND expires_at>statement_timestamp();
 IF j.id IS NULL THEN RAISE EXCEPTION 'EXPORT_INVALIDATED';END IF;
 IF section NOT IN('profile','posts','comments','post_reactions','comment_reactions','media','connections','groups') OR length(after_id)>256 THEN RAISE EXCEPTION 'INVALID_EXPORT_SECTION';END IF;
 WITH page AS(SELECT export_id,item||jsonb_build_object('export_id',export_id) AS item FROM app.export_window(section,j.created_at,after_id,26,NULL)),numbered AS(SELECT *,row_number() OVER(ORDER BY export_id) AS n,sum(octet_length(item::text)) OVER(ORDER BY export_id) AS byte_count FROM page)
 SELECT coalesce(jsonb_agg(item ORDER BY export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)),'[]'::jsonb),CASE WHEN count(*)>count(*) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) THEN max(export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) END INTO rows,next_id FROM numbered;
 RETURN jsonb_build_object('schema_version',1,'generated_at',j.created_at,'next_cursor',next_id,section,CASE WHEN section='profile' THEN rows->0 ELSE rows END);
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
  SELECT item INTO row FROM app.export_window(section,j.created_at,'',1,ref->>'id');
  IF row IS NULL OR(row->'envelope'->'context'->>'revision')::integer IS DISTINCT FROM(ref->>'revision')::integer THEN RETURN false;END IF;
  deadline:=least((row->>'effective_expires_at')::timestamptz,(row->>'expires_at')::timestamptz,(row->'envelope'->'context'->>'expiresAt')::timestamptz);
  IF deadline IS DISTINCT FROM(ref->>'expires_at')::timestamptz OR deadline<=statement_timestamp() THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
CREATE OR REPLACE FUNCTION app.integration_page(token_hash text,requested_scope text,section text,after_id text DEFAULT '',snapshot_at timestamptz DEFAULT statement_timestamp()) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE g app.integration_grants;rows jsonb;next_id text;BEGIN
 SELECT ig.* INTO g FROM app.integration_grants ig JOIN app.members m ON m.id=ig.member_id WHERE ig.access_hash=token_hash AND requested_scope=ANY(ig.scopes) AND ig.access_expires_at>now() AND ig.expires_at>now() AND ig.revoked_at IS NULL AND m.status IN('active','restricted');
 IF g.id IS NULL THEN RAISE EXCEPTION 'INVALID_GRANT';END IF;
 IF length(after_id)>256 OR snapshot_at>statement_timestamp()+interval '1 second' OR NOT((requested_scope='profile:read' AND section='profile') OR(requested_scope='content:read' AND section IN('posts','comments','post_reactions','comment_reactions')) OR(requested_scope='media:read' AND section='media') OR(requested_scope='export:read' AND section='jobs')) THEN RAISE EXCEPTION 'INVALID_GRANT';END IF;
 PERFORM set_config('app.member_id',g.member_id::text,true);
 IF section='jobs' THEN
  WITH page AS(SELECT id::text export_id,to_jsonb(j) item FROM app.data_transfer_jobs j WHERE member_id=g.member_id AND kind='export' AND created_at<=snapshot_at AND id::text>after_id ORDER BY id::text LIMIT 26),numbered AS(SELECT *,row_number() OVER(ORDER BY export_id) n,sum(octet_length(item::text)) OVER(ORDER BY export_id) byte_count FROM page)
  SELECT coalesce(jsonb_agg(item ORDER BY export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)),'[]'::jsonb),CASE WHEN count(*)>count(*) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) THEN max(export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) END INTO rows,next_id FROM numbered;
 ELSE
  WITH page AS(SELECT export_id,item FROM app.export_window(section,snapshot_at,after_id,26,NULL)),numbered AS(SELECT *,row_number() OVER(ORDER BY export_id) n,sum(octet_length(item::text)) OVER(ORDER BY export_id) byte_count FROM page)
  SELECT coalesce(jsonb_agg(item ORDER BY export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)),'[]'::jsonb),CASE WHEN count(*)>count(*) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) THEN max(export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) END INTO rows,next_id FROM numbered;
 END IF;
 UPDATE app.integration_grants SET last_used_at=now() WHERE id=g.id;
 RETURN jsonb_build_object(section,CASE WHEN section='profile' THEN rows->0 ELSE rows END,'next_id',next_id,'snapshot_at',snapshot_at);
END $$;
