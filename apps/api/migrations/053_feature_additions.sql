-- Additive web feature voting workflow. Existing private chats stay private.
ALTER TABLE app.builder_chat_messages ADD COLUMN task_kind text NOT NULL DEFAULT 'chat'
 CHECK(task_kind IN('chat','feature_plan','feature_build'));
ALTER TABLE app.builder_chat_messages ADD COLUMN share_plan boolean NOT NULL DEFAULT false;
CREATE TABLE app.feature_additions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 source_message uuid NOT NULL UNIQUE REFERENCES app.builder_chat_messages ON DELETE CASCADE,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 plan text NOT NULL CHECK(length(plan) BETWEEN 1 AND 12000),
 status text NOT NULL DEFAULT 'voting' CHECK(status IN('voting','queued','working','delivered','needs_attention')),
 build_message uuid UNIQUE REFERENCES app.builder_chat_messages ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.builder_chat_messages ADD COLUMN feature_id uuid REFERENCES app.feature_additions ON DELETE SET NULL;
CREATE TABLE app.feature_votes (
 feature_id uuid NOT NULL REFERENCES app.feature_additions ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 value smallint NOT NULL CHECK(value IN(-1,1)),
 PRIMARY KEY(feature_id,member_id)
);
REVOKE ALL ON app.feature_additions,app.feature_votes FROM PUBLIC;

CREATE FUNCTION app.feature_sharing_consent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.member_id=app.actor() THEN
  NEW.share_plan:=EXISTS(SELECT FROM app.builder_chat_access WHERE member_id=app.actor() AND disclosure_version>=2);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER feature_sharing_consent BEFORE INSERT ON app.builder_chat_messages FOR EACH ROW EXECUTE FUNCTION app.feature_sharing_consent();

CREATE FUNCTION app.feature_score(target uuid) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT coalesce(sum(v.value),0)::integer FROM app.feature_votes v
 JOIN app.members m ON m.id=v.member_id AND m.status='active'
 JOIN app.builder_chat_access a ON a.member_id=v.member_id
 WHERE v.feature_id=target
$$;

CREATE FUNCTION app.feature_board(before_at timestamptz DEFAULT NULL,before_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.builder_chat_allowed() THEN RETURN NULL; END IF;
 RETURN coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC,x.id DESC) FROM (
  SELECT f.id,f.title,f.plan,f.status,f.created_at,
   to_char(f.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
   CASE WHEN NOT app.blocked(f.member_id,app.actor()) THEN p.handle END AS author_handle,
   app.feature_score(f.id) AS score,
   coalesce((SELECT value FROM app.feature_votes WHERE feature_id=f.id AND member_id=app.actor()),0) AS my_vote,
   coalesce(b.commits,'{}'::text[]) AS commits
  FROM app.feature_additions f JOIN app.profiles p ON p.member_id=f.member_id
  LEFT JOIN app.builder_chat_messages b ON b.id=f.build_message
  WHERE f.created_at>now()-interval '90 days' AND (before_at IS NULL OR (f.created_at,f.id)<(before_at,before_id))
  ORDER BY f.created_at DESC,f.id DESC LIMIT 31
 ) x),'[]'::jsonb);
END $$;

CREATE FUNCTION app.feature_submit(message text,daily_limit integer,queue_limit integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE result uuid;
BEGIN
 result:=app.builder_chat_send(message,2,daily_limit,queue_limit);
 UPDATE app.builder_chat_messages SET task_kind='feature_plan' WHERE id=result;
 RETURN result;
END $$;

CREATE FUNCTION app.feature_vote(target uuid,choice integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE f app.feature_additions;
BEGIN
 IF NOT app.builder_chat_allowed() THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF NOT EXISTS(SELECT FROM app.builder_chat_access WHERE member_id=app.actor() AND disclosure_version>=2) THEN RAISE EXCEPTION 'DISCLOSURE_REQUIRED'; END IF;
 IF choice IS NULL OR choice NOT IN(-1,0,1) THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
 -- Same lock as dispatch makes the threshold and vote freeze atomic.
 PERFORM pg_advisory_xact_lock(hashtextextended('porchday-builder-chat-queue',0));
 SELECT * INTO f FROM app.feature_additions WHERE id=target AND created_at>now()-interval '90 days' FOR UPDATE;
 IF f.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF f.status<>'voting' THEN RAISE EXCEPTION 'FEATURE_LOCKED'; END IF;
 IF choice=0 THEN DELETE FROM app.feature_votes WHERE feature_id=target AND member_id=app.actor();
 ELSE INSERT INTO app.feature_votes(feature_id,member_id,value) VALUES(target,app.actor(),choice)
  ON CONFLICT(feature_id,member_id) DO UPDATE SET value=excluded.value;
 END IF;
END $$;

CREATE FUNCTION app.feature_poll(turn_seconds integer,take boolean,waiting_on text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE chosen_feature app.feature_additions; task uuid; message jsonb; claimed_task app.builder_chat_messages;
BEGIN
 IF take THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('porchday-builder-chat-queue',0));
  DELETE FROM app.feature_additions WHERE created_at<now()-interval '90 days';
  -- Failed/timed-out tasks are visible for review, never automatically retried.
  UPDATE app.feature_additions f SET status='needs_attention' FROM app.builder_chat_messages q
   WHERE f.build_message=q.id AND q.status IN('failed','timed_out') AND f.status IN('queued','working');
  UPDATE app.builder_chat_messages SET status='failed',completed_at=now()
   WHERE task_kind='feature_build' AND feature_id IS NULL AND status='queued';
  IF (SELECT count(*) FROM app.builder_chat_messages WHERE status IN('queued','working'))<20 THEN
   SELECT p.* INTO chosen_feature FROM app.feature_additions p JOIN app.members m ON m.id=p.member_id
    JOIN app.builder_chat_access a ON a.member_id=p.member_id
    WHERE p.status='voting' AND m.status='active' AND app.feature_score(p.id)>=3
    AND NOT EXISTS(SELECT FROM app.builder_chat_messages q WHERE q.member_id=p.member_id AND q.status IN('queued','working'))
    ORDER BY p.created_at,p.id LIMIT 1 FOR UPDATE OF p;
   IF chosen_feature.id IS NOT NULL THEN
    INSERT INTO app.builder_chat_messages(member_id,body,task_kind,feature_id)
     VALUES(chosen_feature.member_id,'Implement the approved feature plan.','feature_build',chosen_feature.id) RETURNING id INTO task;
    UPDATE app.feature_additions SET status='queued',build_message=task WHERE id=chosen_feature.id;
   END IF;
  END IF;
 END IF;
 message:=app.builder_chat_poll(turn_seconds,take,waiting_on);
 IF message IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO claimed_task FROM app.builder_chat_messages WHERE id=(message->>'id')::uuid;
 IF claimed_task.task_kind='feature_build' THEN
  SELECT * INTO chosen_feature FROM app.feature_additions WHERE id=claimed_task.feature_id;
  UPDATE app.feature_additions SET status='working' WHERE id=chosen_feature.id;
  RETURN message||jsonb_build_object('task_kind',claimed_task.task_kind,'feature',jsonb_build_object('id',chosen_feature.id,'title',chosen_feature.title,'plan',chosen_feature.plan));
 END IF;
 RETURN message||jsonb_build_object('task_kind',claimed_task.task_kind,'share_plan',claimed_task.share_plan);
END $$;

CREATE FUNCTION app.feature_finish(message_id uuid,final_status text,final_reply text,final_commits text[],held_back text[],proposal jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE m app.builder_chat_messages; recorded boolean;
BEGIN
 SELECT * INTO m FROM app.builder_chat_messages WHERE id=message_id FOR UPDATE;
 recorded:=app.builder_chat_finish(message_id,final_status,final_reply,final_commits,held_back);
 IF m.id IS NULL OR m.status<>'working' THEN RETURN recorded; END IF;
 IF m.task_kind='feature_build' THEN
  UPDATE app.feature_additions SET status=CASE WHEN final_status='answered' AND cardinality(final_commits)>0 AND cardinality(held_back)=0 THEN 'delivered' ELSE 'needs_attention' END WHERE build_message=message_id;
 ELSIF proposal IS NOT NULL AND m.share_plan AND final_status='answered' AND cardinality(final_commits)=0 AND cardinality(held_back)=0
  AND EXISTS(SELECT FROM app.builder_chat_access a JOIN app.members p ON p.id=a.member_id WHERE a.member_id=m.member_id AND p.status='active') THEN
  INSERT INTO app.feature_additions(member_id,source_message,title,plan)
   VALUES(m.member_id,m.id,proposal->>'title',proposal->>'plan') ON CONFLICT(source_message) DO NOTHING;
 END IF;
 RETURN recorded;
END $$;
REVOKE ALL ON FUNCTION app.feature_sharing_consent(),app.feature_score(uuid),app.feature_board(timestamptz,uuid),app.feature_submit(text,integer,integer),app.feature_vote(uuid,integer),app.feature_poll(integer,boolean,text),app.feature_finish(uuid,text,text,text[],text[],jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.feature_board(timestamptz,uuid),app.feature_submit(text,integer,integer),app.feature_vote(uuid,integer) TO porchday_social;
GRANT EXECUTE ON FUNCTION app.feature_poll(integer,boolean,text),app.feature_finish(uuid,text,text,text[],text[],jsonb) TO porchday_jobs;

CREATE FUNCTION app.feature_export() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE original jsonb;
BEGIN
 original:=app.builder_chat_export();
 IF original IS NULL THEN RETURN NULL; END IF;
 RETURN original||jsonb_build_object(
  'feature_plans',coalesce((SELECT jsonb_agg(to_jsonb(f)) FROM app.feature_additions f WHERE member_id=app.actor()),'[]'::jsonb),
  'feature_votes',coalesce((SELECT jsonb_agg(jsonb_build_object('feature_id',feature_id,'value',value)) FROM app.feature_votes WHERE member_id=app.actor()),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION app.feature_export() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.feature_export() TO porchday_social;
