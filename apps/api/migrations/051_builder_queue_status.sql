-- Only fixed activity labels cross the bridge boundary; no lock paths, owners,
-- member identities, or details of someone else's request are exposed.
ALTER TABLE app.builder_chat_bridge ADD COLUMN activity text NOT NULL DEFAULT 'unknown'
 CHECK(activity IN('unknown','idle','request_file','other_work'));

CREATE FUNCTION app.builder_chat_poll(turn_seconds integer,take boolean,waiting_on text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE message jsonb;
BEGIN
 IF waiting_on IS NULL OR waiting_on NOT IN('request_file','other_work') THEN RAISE EXCEPTION 'INVALID_ACTIVITY'; END IF;
 message:=app.builder_chat_claim(turn_seconds,take);
 UPDATE app.builder_chat_bridge SET activity=CASE WHEN take THEN 'idle' ELSE waiting_on END WHERE id;
 RETURN message;
END $$;
REVOKE ALL ON FUNCTION app.builder_chat_poll(integer,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.builder_chat_poll(integer,boolean,text) TO porchday_jobs;

CREATE OR REPLACE FUNCTION app.builder_chat_state() RETURNS jsonb
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
  'bridge_activity',CASE WHEN EXISTS(SELECT FROM app.builder_chat_messages WHERE status='working') THEN 'chat' ELSE (SELECT activity FROM app.builder_chat_bridge) END,
  'ahead',CASE WHEN pending.status='queued' THEN (SELECT count(*) FROM app.builder_chat_messages WHERE status IN('queued','working') AND created_at<pending.created_at) ELSE 0 END,
  'sent_today',(SELECT count(*) FROM app.builder_chat_messages WHERE member_id=app.actor() AND created_at>now()-interval '1 day'),
  'messages',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.created_at) FROM(
    SELECT id,body,status,progress,reply,commits,created_at,completed_at FROM app.builder_chat_messages
    WHERE member_id=app.actor() ORDER BY created_at DESC LIMIT 50) m),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END $$;

