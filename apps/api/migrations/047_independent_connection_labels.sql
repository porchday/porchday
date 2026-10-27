-- Friendship is mutual; each member independently classifies the other person.
-- Preserve the previously agreed label in both directions. Pending proposals
-- were never effective consent and must not widen an audience during migration.
ALTER TABLE app.connections ADD COLUMN kind_a text CHECK(kind_a IN('friend','family'));
ALTER TABLE app.connections ADD COLUMN kind_b text CHECK(kind_b IN('friend','family'));
UPDATE app.connections SET kind_a=kind,kind_b=kind,proposed_kind=NULL,proposed_by=NULL;
ALTER TABLE app.connections ALTER COLUMN kind_a SET NOT NULL;
ALTER TABLE app.connections ALTER COLUMN kind_b SET NOT NULL;

-- Keep legacy administrative imports valid. Runtime members cannot insert or
-- update this table directly; all live authorization uses kind_a/kind_b only.
CREATE FUNCTION app.initialize_connection_labels() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 NEW.kind_a:=coalesce(NEW.kind_a,NEW.kind);
 NEW.kind_b:=coalesce(NEW.kind_b,NEW.kind);
 NEW.proposed_kind:=NULL;NEW.proposed_by:=NULL;
 RETURN NEW;
END $$;
CREATE TRIGGER initialize_connection_labels BEFORE INSERT ON app.connections
 FOR EACH ROW EXECUTE FUNCTION app.initialize_connection_labels();

-- The first argument is the content author, not the viewer. All existing post,
-- comment/media, audience-device, history and profile checks preserve this order.
CREATE OR REPLACE FUNCTION app.connected(a uuid,b uuid,family boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT FROM app.connections c
  WHERE c.member_a=least(a,b) AND c.member_b=greatest(a,b)
   AND(NOT family OR CASE WHEN c.member_a=a THEN c.kind_a ELSE c.kind_b END='family'))
  AND NOT app.blocked(a,b)
$$;
CREATE OR REPLACE FUNCTION app.friends(a uuid,b uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT FROM app.connections c
  WHERE c.member_a=least(a,b) AND c.member_b=greatest(a,b)
   AND CASE WHEN c.member_a=a THEN c.kind_a ELSE c.kind_b END='friend')
  AND NOT app.blocked(a,b)
$$;

CREATE FUNCTION app.accept_connection_with_preferences(request_id uuid,own_history text,own_kind text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r app.connection_requests; result uuid;
BEGIN
 IF NOT app.may_write() OR own_history IS NULL OR own_history NOT IN('future','full')
  OR own_kind IS NULL OR own_kind NOT IN('friend','family') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO r FROM app.connection_requests WHERE id=request_id;
 IF r.recipient IS DISTINCT FROM app.actor() THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM app.lock_pair(r.sender,r.recipient);
 SELECT * INTO r FROM app.connection_requests WHERE id=request_id FOR UPDATE;
 IF r.recipient IS DISTINCT FROM app.actor() THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF r.state='accepted' THEN
  SELECT id INTO result FROM app.connections WHERE member_a=least(r.sender,r.recipient) AND member_b=greatest(r.sender,r.recipient);
  IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  RETURN result;
 END IF;
 IF r.state<>'pending' OR app.blocked(r.sender,r.recipient) OR NOT EXISTS(SELECT FROM app.members WHERE id=r.sender AND status='active') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF (SELECT count(*) FROM app.connections WHERE r.sender IN(member_a,member_b))>=300 OR (SELECT count(*) FROM app.connections WHERE r.recipient IN(member_a,member_b))>=300 THEN RAISE EXCEPTION 'CONNECTION_LIMIT'; END IF;
 INSERT INTO app.connections(member_a,member_b,kind,kind_a,kind_b,history_a,history_b)
 VALUES(least(r.sender,r.recipient),greatest(r.sender,r.recipient),r.kind,
  CASE WHEN r.sender<r.recipient THEN r.kind ELSE own_kind END,
  CASE WHEN r.sender<r.recipient THEN own_kind ELSE r.kind END,
  CASE WHEN r.sender<r.recipient THEN r.history ELSE own_history END,
  CASE WHEN r.sender<r.recipient THEN own_history ELSE r.history END) RETURNING id INTO result;
 UPDATE app.connection_requests SET state='accepted' WHERE id=request_id;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 INSERT INTO app.notifications(recipient,actor,kind,dedupe_key) VALUES(r.sender,r.recipient,'connection_accepted','connection:'||request_id) ON CONFLICT DO NOTHING;
 RETURN result;
END $$;
-- Old clients choose Friend for themselves rather than inheriting the sender's
-- choice. Repeated acceptance still cannot change either person's preferences.
CREATE OR REPLACE FUNCTION app.accept_connection_with_history(request_id uuid,own_history text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.accept_connection_with_preferences(request_id,own_history,'friend')
$$;
CREATE OR REPLACE FUNCTION app.accept_connection(request_id uuid) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.accept_connection_with_preferences(request_id,'future','friend')
$$;

CREATE OR REPLACE FUNCTION app.change_connection(connection_id uuid,new_kind text,remove boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r app.connections;
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO r FROM app.connections WHERE id=connection_id;
 IF r.id IS NULL OR app.actor() NOT IN(r.member_a,r.member_b) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM app.lock_pair(r.member_a,r.member_b);
 SELECT * INTO r FROM app.connections WHERE id=connection_id FOR UPDATE;
 IF r.id IS NULL OR app.actor() NOT IN(r.member_a,r.member_b) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF remove THEN DELETE FROM app.connections WHERE id=connection_id;
 ELSE
  IF new_kind IS NULL OR new_kind NOT IN('friend','family') THEN RAISE EXCEPTION 'INVALID_KIND'; END IF;
  IF (CASE WHEN r.member_a=app.actor() THEN r.kind_a ELSE r.kind_b END)=new_kind THEN RETURN; END IF;
  UPDATE app.connections SET
   kind_a=CASE WHEN member_a=app.actor() THEN new_kind ELSE kind_a END,
   kind_b=CASE WHEN member_b=app.actor() THEN new_kind ELSE kind_b END,
   proposed_kind=NULL,proposed_by=NULL
  WHERE id=connection_id;
 END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
END $$;

-- Reclassifying someone can revoke only grants authored by the person changing
-- their label. The reverse direction and broad Friends & family posts remain.
DROP TRIGGER revoke_family_history ON app.connections;
CREATE OR REPLACE FUNCTION app.revoke_family_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF OLD.kind_a IS DISTINCT FROM NEW.kind_a THEN
  DELETE FROM app.post_recipients r USING app.posts p WHERE r.post_id=p.id
   AND p.author_id=OLD.member_a AND r.member_id=OLD.member_b
   AND p.audience=CASE OLD.kind_a WHEN 'friend' THEN 'friends' ELSE 'family' END;
 END IF;
 IF OLD.kind_b IS DISTINCT FROM NEW.kind_b THEN
  DELETE FROM app.post_recipients r USING app.posts p WHERE r.post_id=p.id
   AND p.author_id=OLD.member_b AND r.member_id=OLD.member_a
   AND p.audience=CASE OLD.kind_b WHEN 'friend' THEN 'friends' ELSE 'family' END;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revoke_family_history AFTER UPDATE OF kind_a,kind_b ON app.connections
 FOR EACH ROW EXECUTE FUNCTION app.revoke_family_history();

-- Both label transitions leave a narrow audience. Existing restrictive restore
-- replay deletes the relationship instead of reviving an older classification.
CREATE FUNCTION app.capture_connection_label_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.kind_a IS DISTINCT FROM NEW.kind_a OR OLD.kind_b IS DISTINCT FROM NEW.kind_b THEN
  PERFORM app.append_safety_decision(jsonb_build_object('action','connection','a',OLD.member_a,'b',OLD.member_b));
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS journal_connection ON app.connections;
CREATE TRIGGER journal_connection AFTER DELETE OR UPDATE OF kind_a,kind_b ON app.connections
 FOR EACH ROW EXECUTE FUNCTION app.capture_connection_label_decision();

REVOKE ALL ON FUNCTION app.initialize_connection_labels(),app.capture_connection_label_decision(),app.accept_connection_with_preferences(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_connection_with_preferences(uuid,text,text) TO porchday_social;

-- Exports include the exporting member's classification, never the peer's label.
CREATE OR REPLACE FUNCTION app.export_owned() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT CASE WHEN app.may_manage_data() THEN jsonb_build_object(
 'schema_version',1,'generated_at',statement_timestamp(),
 'profile',(SELECT to_jsonb(p) FROM app.profiles p WHERE member_id=app.actor()),
 'posts',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM app.posts p WHERE author_id=app.actor() AND(expires_at IS NULL OR expires_at>statement_timestamp())),'[]'::jsonb),
 'comments',coalesce((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('effective_expires_at',app.comment_deadline(c.id))) FROM app.comments c JOIN app.posts p ON p.id=c.post_id WHERE c.author_id=app.actor() AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp()) AND(app.comment_deadline(c.id) IS NULL OR app.comment_deadline(c.id)>statement_timestamp())),'[]'::jsonb),
 'post_reactions',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM app.post_reactions r JOIN app.posts p ON p.id=r.post_id WHERE r.member_id=app.actor() AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())),'[]'::jsonb),
 'comment_reactions',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM app.comment_reactions r WHERE r.member_id=app.actor() AND(app.comment_deadline(r.comment_id) IS NULL OR app.comment_deadline(r.comment_id)>statement_timestamp())),'[]'::jsonb),
 'media',coalesce((SELECT jsonb_agg(to_jsonb(m)-'object_key') FROM app.media_assets m LEFT JOIN app.posts p ON p.id=m.post_id WHERE m.owner_id=app.actor() AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())),'[]'::jsonb),
 'connections',coalesce((SELECT jsonb_agg(jsonb_build_object('member_id',CASE WHEN member_a=app.actor() THEN member_b ELSE member_a END,'kind',CASE WHEN member_a=app.actor() THEN kind_a ELSE kind_b END)) FROM app.connections WHERE app.actor() IN(member_a,member_b)),'[]'::jsonb),
 'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('group_id',group_id,'role',role)) FROM app.group_memberships WHERE member_id=app.actor()),'[]'::jsonb)
 ) ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION app.export_items(section text,snapshot_at timestamptz) RETURNS TABLE(export_id text,item jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT p.member_id::text,to_jsonb(p) FROM app.profiles p WHERE section='profile' AND p.member_id=app.actor()
 UNION ALL SELECT p.id::text,to_jsonb(p) FROM app.posts p WHERE section='posts' AND p.author_id=app.actor() AND p.stored_at<=snapshot_at AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())
 UNION ALL SELECT c.id::text,to_jsonb(c)||jsonb_build_object('effective_expires_at',app.comment_deadline(c.id)) FROM app.comments c WHERE section='comments' AND c.author_id=app.actor() AND c.stored_at<=snapshot_at AND(app.comment_deadline(c.id) IS NULL OR app.comment_deadline(c.id)>statement_timestamp())
 UNION ALL SELECT r.post_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.post_reactions r JOIN app.posts p ON p.id=r.post_id WHERE section='post_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT r.comment_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.comment_reactions r WHERE section='comment_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT m.id::text,(to_jsonb(m)-'object_key')||jsonb_build_object('effective_expires_at',app.media_deadline(m.id)) FROM app.media_assets m WHERE section='media' AND m.owner_id=app.actor() AND m.state IN('ready','attached') AND m.created_at<=snapshot_at AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp())
 UNION ALL SELECT (CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END)::text,jsonb_build_object('member_id',CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END,'kind',CASE WHEN c.member_a=app.actor() THEN c.kind_a ELSE c.kind_b END) FROM app.connections c WHERE section='connections' AND app.actor() IN(c.member_a,c.member_b) AND c.accepted_at<=snapshot_at
 UNION ALL SELECT g.group_id::text,jsonb_build_object('group_id',g.group_id,'role',g.role) FROM app.group_memberships g WHERE section='groups' AND g.member_id=app.actor() AND g.joined_at<=snapshot_at
$$;

CREATE OR REPLACE FUNCTION app.export_window(section text,snapshot_at timestamptz,after_id text,take_count integer,exact_id text) RETURNS TABLE(export_id text,item jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT owned.export_id,owned.item FROM (
 SELECT p.member_id::text,to_jsonb(p) FROM app.profiles p WHERE section='profile' AND p.member_id=app.actor()
 UNION ALL SELECT e.member_id::text,to_jsonb(e) FROM app.emoji_libraries e WHERE section='emoji_library' AND e.member_id=app.actor() AND e.envelope IS NOT NULL
 UNION ALL SELECT p.id::text,to_jsonb(p) FROM app.posts p WHERE section='posts' AND p.author_id=app.actor() AND p.stored_at<=snapshot_at AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())
 UNION ALL SELECT c.id::text,to_jsonb(c)||jsonb_build_object('effective_expires_at',app.comment_deadline(c.id)) FROM app.comments c WHERE section='comments' AND c.author_id=app.actor() AND c.stored_at<=snapshot_at AND(app.comment_deadline(c.id) IS NULL OR app.comment_deadline(c.id)>statement_timestamp())
 UNION ALL SELECT r.post_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.post_reactions r JOIN app.posts p ON p.id=r.post_id WHERE section='post_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT r.comment_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.comment_reactions r WHERE section='comment_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT m.id::text,(to_jsonb(m)-'object_key')||jsonb_build_object('effective_expires_at',app.media_deadline(m.id)) FROM app.media_assets m WHERE section='media' AND m.owner_id=app.actor() AND m.state IN('ready','attached') AND m.created_at<=snapshot_at AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp())
 UNION ALL SELECT (CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END)::text,jsonb_build_object('member_id',CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END,'kind',CASE WHEN c.member_a=app.actor() THEN c.kind_a ELSE c.kind_b END) FROM app.connections c WHERE section='connections' AND app.actor() IN(c.member_a,c.member_b) AND c.accepted_at<=snapshot_at
 UNION ALL SELECT g.group_id::text,jsonb_build_object('group_id',g.group_id,'role',g.role) FROM app.group_memberships g WHERE section='groups' AND g.member_id=app.actor() AND g.joined_at<=snapshot_at
 ) owned(export_id,item) WHERE CASE WHEN exact_id IS NULL THEN owned.export_id>after_id ELSE owned.export_id=exact_id END
 ORDER BY owned.export_id LIMIT least(greatest(take_count,1),26)
$$;

