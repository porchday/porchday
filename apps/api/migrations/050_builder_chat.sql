-- Builder chat: allowlisted members exchange plain-text messages with the
-- Codex session that develops Porchday. See design/builder-chat.md.
-- Rows are not end-to-end encrypted; operators can read them. Every row is
-- owned by a member and cascades with account deletion.
CREATE TABLE app.builder_chat_access (
  member_id uuid PRIMARY KEY REFERENCES app.members ON DELETE CASCADE,
  enabled_by text NOT NULL CHECK(length(enabled_by) BETWEEN 1 AND 254),
  enabled_at timestamptz NOT NULL DEFAULT now(),
  disclosure_version integer CHECK(disclosure_version>0),
  disclosure_accepted_at timestamptz,
  CHECK((disclosure_version IS NULL)=(disclosure_accepted_at IS NULL))
);
CREATE TABLE app.builder_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','working','answered','timed_out','failed')),
  progress text CHECK(progress IN('reading','editing','testing','committing','working')),
  reply text NOT NULL DEFAULT '' CHECK(length(reply)<=20000),
  commits text[] NOT NULL DEFAULT '{}' CHECK(cardinality(commits)<=50),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX builder_chat_messages_queue ON app.builder_chat_messages(created_at) WHERE status IN('queued','working');
CREATE INDEX builder_chat_messages_member ON app.builder_chat_messages(member_id,created_at);
CREATE INDEX builder_chat_messages_age ON app.builder_chat_messages(created_at);
-- Operator record. Details hold event metadata only, never message text or
-- held-back output.
CREATE TABLE app.builder_chat_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id uuid REFERENCES app.members ON DELETE CASCADE,
  message_id uuid REFERENCES app.builder_chat_messages ON DELETE CASCADE,
  event text NOT NULL CHECK(event IN('access_added','access_removed','disclosure_accepted','claimed','answered','timed_out','failed','held_back','cancelled')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(octet_length(detail::text)<=2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX builder_chat_audit_created ON app.builder_chat_audit(created_at);
CREATE TABLE app.builder_chat_bridge (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  seen_at timestamptz
);
INSERT INTO app.builder_chat_bridge(id) VALUES(true);

-- Member functions run as porchday_social with app.actor() set. A member who
-- is not on the allowlist gets NULL or NOT_FOUND, never a distinct error.
CREATE FUNCTION app.builder_chat_allowed() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.may_read() AND EXISTS(SELECT FROM app.builder_chat_access WHERE member_id=app.actor())
$$;

CREATE FUNCTION app.builder_chat_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE a app.builder_chat_access; pending app.builder_chat_messages; result jsonb;
BEGIN
 IF NOT app.builder_chat_allowed() THEN RETURN NULL; END IF;
 SELECT * INTO a FROM app.builder_chat_access WHERE member_id=app.actor();
 DELETE FROM app.builder_chat_messages WHERE member_id=app.actor() AND created_at<now()-interval '90 days';
 SELECT * INTO pending FROM app.builder_chat_messages WHERE member_id=app.actor() AND status IN('queued','working') ORDER BY created_at LIMIT 1;
 SELECT jsonb_build_object(
  'disclosure_version',a.disclosure_version,
  'bridge_seen_at',(SELECT seen_at FROM app.builder_chat_bridge),
  'ahead',CASE WHEN pending.status='queued' THEN (SELECT count(*) FROM app.builder_chat_messages WHERE status IN('queued','working') AND created_at<pending.created_at) ELSE 0 END,
  'sent_today',(SELECT count(*) FROM app.builder_chat_messages WHERE member_id=app.actor() AND created_at>now()-interval '1 day'),
  'messages',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.created_at) FROM(
    SELECT id,body,status,progress,reply,commits,created_at,completed_at FROM app.builder_chat_messages
    WHERE member_id=app.actor() ORDER BY created_at DESC LIMIT 50) m),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END $$;

CREATE FUNCTION app.builder_chat_accept(version integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.builder_chat_allowed() THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF version IS NULL OR version<1 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 UPDATE app.builder_chat_access SET disclosure_version=version,disclosure_accepted_at=now() WHERE member_id=app.actor();
 INSERT INTO app.builder_chat_audit(member_id,event,detail) VALUES(app.actor(),'disclosure_accepted',jsonb_build_object('version',version));
END $$;

CREATE FUNCTION app.builder_chat_send(message text,required_version integer,daily_limit integer,queue_limit integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE result uuid;
BEGIN
 IF NOT app.builder_chat_allowed() THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT FROM app.builder_chat_access WHERE member_id=app.actor() AND disclosure_version>=required_version) THEN RAISE EXCEPTION 'DISCLOSURE_REQUIRED'; END IF;
 IF message IS NULL OR length(btrim(message))=0 OR length(message)>2000 THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
 -- One global lock keeps the queue limit and the one-in-flight rule exact.
 PERFORM pg_advisory_xact_lock(hashtextextended('porchday-builder-chat-queue',0));
 IF EXISTS(SELECT FROM app.builder_chat_messages WHERE member_id=app.actor() AND status IN('queued','working')) THEN RAISE EXCEPTION 'IN_FLIGHT'; END IF;
 IF (SELECT count(*) FROM app.builder_chat_messages WHERE member_id=app.actor() AND created_at>now()-interval '1 day')>=daily_limit THEN RAISE EXCEPTION 'DAILY_LIMIT'; END IF;
 IF (SELECT count(*) FROM app.builder_chat_messages WHERE status IN('queued','working'))>=queue_limit THEN RAISE EXCEPTION 'QUEUE_FULL'; END IF;
 INSERT INTO app.builder_chat_messages(member_id,body) VALUES(app.actor(),message) RETURNING id INTO result;
 RETURN result;
END $$;

CREATE FUNCTION app.builder_chat_export() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.may_manage_data() OR NOT EXISTS(SELECT FROM app.builder_chat_messages WHERE member_id=app.actor()) AND NOT EXISTS(SELECT FROM app.builder_chat_access WHERE member_id=app.actor()) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('schema_version',1,'generated_at',now(),'messages',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'id',id,'message',body,'status',status,'reply',reply,'commits',to_jsonb(commits),'created_at',created_at,'completed_at',completed_at) ORDER BY created_at)
  FROM app.builder_chat_messages WHERE member_id=app.actor()),'[]'::jsonb));
END $$;

-- Bridge functions run as porchday_jobs after the Worker checks the bridge
-- token. They never receive a member session.
-- With take=false the call only records that the bridge is connected, e.g.
-- while another builder job holds the shared lock.
CREATE FUNCTION app.builder_chat_claim(turn_seconds integer,take boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE m app.builder_chat_messages; handle text;
BEGIN
 UPDATE app.builder_chat_bridge SET seen_at=now() WHERE id;
 IF NOT take THEN RETURN NULL; END IF;
 DELETE FROM app.builder_chat_messages WHERE created_at<now()-interval '90 days';
 DELETE FROM app.builder_chat_audit WHERE created_at<now()-interval '90 days';
 -- A bridge that stopped mid-turn must not leave a member waiting forever.
 WITH stale AS(UPDATE app.builder_chat_messages SET status='timed_out',progress=NULL,completed_at=now()
  WHERE status='working' AND started_at<now()-make_interval(secs=>turn_seconds+120) RETURNING id,member_id)
 INSERT INTO app.builder_chat_audit(member_id,message_id,event,detail) SELECT member_id,id,'timed_out','{"by":"server"}'::jsonb FROM stale;
 PERFORM pg_advisory_xact_lock(hashtextextended('porchday-builder-chat-queue',0));
 IF EXISTS(SELECT FROM app.builder_chat_messages WHERE status='working') THEN RETURN NULL; END IF;
 SELECT q.* INTO m FROM app.builder_chat_messages q JOIN app.builder_chat_access a USING(member_id) JOIN app.members p ON p.id=q.member_id
  WHERE q.status='queued' AND p.status='active' ORDER BY q.created_at LIMIT 1 FOR UPDATE OF q;
 IF m.id IS NULL THEN RETURN NULL; END IF;
 UPDATE app.builder_chat_messages SET status='working',progress='reading',started_at=now() WHERE id=m.id;
 INSERT INTO app.builder_chat_audit(member_id,message_id,event) VALUES(m.member_id,m.id,'claimed');
 SELECT p.handle INTO handle FROM app.profiles p WHERE p.member_id=m.member_id;
 RETURN jsonb_build_object('id',m.id,'member_id',m.member_id,'handle',handle,'body',m.body,'created_at',m.created_at);
END $$;

-- Returns false when the bridge should stop sending progress: the message
-- finished, timed out, or the member lost access while Codex was working.
-- The bridge lets the Codex turn finish so the checkout is never left half
-- edited, and still records its commits.
CREATE FUNCTION app.builder_chat_progress(message_id uuid,new_reply text,new_progress text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE m app.builder_chat_messages;
BEGIN
 UPDATE app.builder_chat_bridge SET seen_at=now() WHERE id;
 SELECT * INTO m FROM app.builder_chat_messages WHERE id=message_id FOR UPDATE;
 IF m.id IS NULL OR m.status<>'working' THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT FROM app.builder_chat_access a JOIN app.members p ON p.id=a.member_id WHERE a.member_id=m.member_id AND p.status='active') THEN
  UPDATE app.builder_chat_messages SET status='failed',progress=NULL,completed_at=now() WHERE id=message_id;
  INSERT INTO app.builder_chat_audit(member_id,message_id,event,detail) VALUES(m.member_id,m.id,'cancelled','{"reason":"access"}'::jsonb);
  RETURN false;
 END IF;
 UPDATE app.builder_chat_messages SET reply=left(coalesce(new_reply,''),20000),progress=new_progress WHERE id=message_id;
 RETURN true;
END $$;

CREATE FUNCTION app.builder_chat_finish(message_id uuid,final_status text,final_reply text,final_commits text[],held_back text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE m app.builder_chat_messages;
BEGIN
 IF final_status NOT IN('answered','timed_out','failed') THEN RAISE EXCEPTION 'INVALID_STATUS'; END IF;
 UPDATE app.builder_chat_bridge SET seen_at=now() WHERE id;
 SELECT * INTO m FROM app.builder_chat_messages WHERE id=message_id FOR UPDATE;
 IF m.id IS NULL THEN RETURN false; END IF;
 -- Commits are recorded even when the server already ended the turn, so a
 -- rollback can always find them.
 UPDATE app.builder_chat_messages SET
  status=CASE WHEN status='working' THEN final_status ELSE status END,
  reply=CASE WHEN status='working' THEN left(coalesce(final_reply,''),20000) ELSE reply END,
  progress=NULL,commits=(SELECT coalesce(array_agg(DISTINCT c),'{}') FROM unnest(commits||coalesce(final_commits,'{}')) c),
  completed_at=coalesce(completed_at,now())
 WHERE id=message_id;
 INSERT INTO app.builder_chat_audit(member_id,message_id,event,detail)
  VALUES(m.member_id,m.id,final_status,jsonb_build_object('commits',to_jsonb(coalesce(final_commits,'{}'))));
 IF cardinality(held_back)>0 THEN
  INSERT INTO app.builder_chat_audit(member_id,message_id,event,detail) VALUES(m.member_id,m.id,'held_back',jsonb_build_object('patterns',to_jsonb(held_back)));
 END IF;
 RETURN true;
END $$;

-- Staff view runs as porchday_auth, like the moderation console.
ALTER TABLE public.staff_users DROP CONSTRAINT staff_roles_allowed;
ALTER TABLE public.staff_users ADD CONSTRAINT staff_roles_allowed CHECK(roles <@ ARRAY['recovery','moderation','builder_chat']::text[]);
CREATE FUNCTION app.builder_chat_staff_view(staff text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app,public AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.staff_users s WHERE s.subject=staff AND s.active AND 'builder_chat'=ANY(s.roles)) THEN RAISE EXCEPTION 'STAFF_FORBIDDEN'; END IF;
 RETURN jsonb_build_object(
  'bridge_seen_at',(SELECT seen_at FROM app.builder_chat_bridge),
  'access',coalesce((SELECT jsonb_agg(jsonb_build_object('handle',p.handle,'enabled_by',a.enabled_by,'enabled_at',a.enabled_at,'disclosure_version',a.disclosure_version) ORDER BY p.handle)
   FROM app.builder_chat_access a JOIN app.profiles p USING(member_id)),'[]'::jsonb),
  'messages',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM(
   SELECT m.id,p.handle,m.body,m.status,m.reply,m.commits,m.created_at,m.started_at,m.completed_at
   FROM app.builder_chat_messages m JOIN app.profiles p USING(member_id) ORDER BY m.created_at DESC LIMIT 200) x),'[]'::jsonb),
  'audit',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id DESC) FROM(
   SELECT l.id,p.handle,l.message_id,l.event,l.detail,l.created_at
   FROM app.builder_chat_audit l LEFT JOIN app.profiles p USING(member_id) ORDER BY l.id DESC LIMIT 200) x),'[]'::jsonb));
END $$;

REVOKE ALL ON app.builder_chat_access,app.builder_chat_messages,app.builder_chat_audit,app.builder_chat_bridge FROM PUBLIC;
REVOKE ALL ON FUNCTION app.builder_chat_allowed(),app.builder_chat_state(),app.builder_chat_accept(integer),
 app.builder_chat_send(text,integer,integer,integer),app.builder_chat_export(),app.builder_chat_claim(integer,boolean),
 app.builder_chat_progress(uuid,text,text),app.builder_chat_finish(uuid,text,text,text[],text[]),app.builder_chat_staff_view(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.builder_chat_state(),app.builder_chat_accept(integer),app.builder_chat_send(text,integer,integer,integer),app.builder_chat_export() TO porchday_social;
GRANT EXECUTE ON FUNCTION app.builder_chat_claim(integer,boolean),app.builder_chat_progress(uuid,text,text),app.builder_chat_finish(uuid,text,text,text[],text[]) TO porchday_jobs;
GRANT EXECUTE ON FUNCTION app.builder_chat_staff_view(text) TO porchday_auth;
