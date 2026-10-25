-- Server insertion time remains distinct from an imported historical publication date.
ALTER TABLE app.posts ADD COLUMN stored_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE app.comments ADD COLUMN stored_at timestamptz NOT NULL DEFAULT now();
-- Private helper: only the member's authored contributions, including their own
-- historical group contributions. Never exports another person's post body.
CREATE FUNCTION app.export_items(section text,snapshot_at timestamptz) RETURNS TABLE(export_id text,item jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT p.member_id::text,to_jsonb(p) FROM app.profiles p WHERE section='profile' AND p.member_id=app.actor()
 UNION ALL SELECT p.id::text,to_jsonb(p) FROM app.posts p WHERE section='posts' AND p.author_id=app.actor() AND p.stored_at<=snapshot_at AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())
 UNION ALL SELECT c.id::text,to_jsonb(c)||jsonb_build_object('effective_expires_at',app.comment_deadline(c.id)) FROM app.comments c WHERE section='comments' AND c.author_id=app.actor() AND c.stored_at<=snapshot_at AND(app.comment_deadline(c.id) IS NULL OR app.comment_deadline(c.id)>statement_timestamp())
 UNION ALL SELECT r.post_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.post_reactions r JOIN app.posts p ON p.id=r.post_id WHERE section='post_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT r.comment_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.comment_reactions r WHERE section='comment_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT m.id::text,(to_jsonb(m)-'object_key')||jsonb_build_object('effective_expires_at',app.media_deadline(m.id)) FROM app.media_assets m WHERE section='media' AND m.owner_id=app.actor() AND m.state IN('ready','attached') AND m.created_at<=snapshot_at AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp())
 UNION ALL SELECT (CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END)::text,jsonb_build_object('member_id',CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END,'kind',c.kind) FROM app.connections c WHERE section='connections' AND app.actor() IN(c.member_a,c.member_b) AND c.accepted_at<=snapshot_at
 UNION ALL SELECT g.group_id::text,jsonb_build_object('group_id',g.group_id,'role',g.role) FROM app.group_memberships g WHERE section='groups' AND g.member_id=app.actor() AND g.joined_at<=snapshot_at
$$;
CREATE FUNCTION app.export_page(job uuid,section text,after_id text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.data_transfer_jobs;rows jsonb;next_id text;BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT * INTO j FROM app.data_transfer_jobs WHERE id=job AND member_id=app.actor() AND kind='export' AND state='complete' AND expires_at>statement_timestamp();
 IF j.id IS NULL THEN RAISE EXCEPTION 'EXPORT_INVALIDATED';END IF;
 IF section NOT IN('profile','posts','comments','post_reactions','comment_reactions','media','connections','groups') OR length(after_id)>256 THEN RAISE EXCEPTION 'INVALID_EXPORT_SECTION';END IF;
 WITH page AS(SELECT export_id,item||jsonb_build_object('export_id',export_id) AS item FROM app.export_items(section,j.created_at) WHERE export_id>after_id ORDER BY export_id LIMIT 26),numbered AS(SELECT *,row_number() OVER(ORDER BY export_id) AS n FROM page)
 SELECT coalesce(jsonb_agg(item ORDER BY export_id) FILTER(WHERE n<=25),'[]'::jsonb),CASE WHEN count(*)>25 THEN max(export_id) FILTER(WHERE n=25) END INTO rows,next_id FROM numbered;
 RETURN jsonb_build_object('schema_version',1,'generated_at',j.created_at,'next_cursor',next_id,section,CASE WHEN section='profile' THEN rows->0 ELSE rows END);
END $$;
CREATE OR REPLACE FUNCTION app.export_media(job uuid,media uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE result text;BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF NOT EXISTS(SELECT FROM app.data_transfer_jobs WHERE id=job AND member_id=app.actor() AND kind='export' AND state='complete' AND expires_at>statement_timestamp()) THEN RAISE EXCEPTION 'EXPORT_INVALIDATED';END IF;
 SELECT m.object_key INTO result FROM app.media_assets m JOIN app.data_transfer_jobs j ON j.id=job WHERE m.id=media AND m.owner_id=app.actor() AND m.state IN('ready','attached') AND m.created_at<=j.created_at AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp());
 IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.export_items(text,timestamptz),app.export_page(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.export_page(uuid,text,text) TO porchday_social;
