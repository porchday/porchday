-- Push endpoints are delivery capabilities, not public profile information. A
-- subscription belongs to the verified session that explicitly enrolled it.
CREATE TABLE app.push_subscriptions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 session_id text NOT NULL REFERENCES public.auth_session(id) ON DELETE CASCADE,
 endpoint text NOT NULL UNIQUE CHECK(length(endpoint)<=2048 AND endpoint ~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|web[.]push[.]apple[.]com|[a-z0-9-]+[.]notify[.]windows[.]com)/[^[:space:]]+$'),
 p256dh text NOT NULL CHECK(p256dh ~ '^[A-Za-z0-9_-]{87}$'),
 auth text NOT NULL CHECK(auth ~ '^[A-Za-z0-9_-]{22}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_member ON app.push_subscriptions(member_id);
CREATE INDEX push_subscriptions_session ON app.push_subscriptions(session_id);
CREATE TABLE app.push_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 notification_id uuid NOT NULL REFERENCES app.notifications ON DELETE CASCADE,
 subscription_id uuid NOT NULL REFERENCES app.push_subscriptions ON DELETE CASCADE,
 attempts integer NOT NULL DEFAULT 0,
 lease uuid,
 next_retry timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 outcome text CHECK(outcome IN('sent','unavailable','failed','expired')),
 UNIQUE(notification_id,subscription_id)
);
CREATE INDEX push_outbox_pending ON app.push_outbox(next_retry) WHERE completed_at IS NULL;
ALTER TABLE app.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_own_read ON app.push_subscriptions FOR SELECT USING(member_id=app.actor() AND app.may_read());
CREATE POLICY push_own_delete ON app.push_subscriptions FOR DELETE USING(member_id=app.actor() AND app.may_read());
REVOKE ALL ON app.push_subscriptions,app.push_outbox FROM PUBLIC;
GRANT SELECT(id,member_id,session_id,created_at,last_used_at),DELETE ON app.push_subscriptions TO porchday_social;

CREATE FUNCTION app.register_push(sid text,url text,dh text,secret text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE existing app.push_subscriptions; result uuid;
BEGIN
 IF NOT app.may_read() OR NOT EXISTS(SELECT FROM public.auth_session WHERE id=sid AND "userId"=app.actor()::text AND "expiresAt">now()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 -- Serialize registrations for this member, including the bounded device limit.
 PERFORM 1 FROM app.members WHERE id=app.actor() FOR UPDATE;
 SELECT * INTO existing FROM app.push_subscriptions WHERE endpoint=url FOR UPDATE;
 IF existing.id IS NOT NULL AND existing.member_id<>app.actor() THEN RAISE EXCEPTION 'PUSH_ENDPOINT_IN_USE'; END IF;
 IF existing.id IS NULL AND (SELECT count(*) FROM app.push_subscriptions WHERE member_id=app.actor())>=10 THEN RAISE EXCEPTION 'PUSH_DEVICE_LIMIT'; END IF;
 INSERT INTO app.push_subscriptions(member_id,session_id,endpoint,p256dh,auth)
 VALUES(app.actor(),sid,url,dh,secret)
 ON CONFLICT(endpoint) DO UPDATE SET session_id=excluded.session_id,p256dh=excluded.p256dh,auth=excluded.auth,last_used_at=now() WHERE app.push_subscriptions.member_id=app.actor()
 RETURNING id INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'PUSH_ENDPOINT_IN_USE'; END IF;
 UPDATE app.members SET notification_preferences=jsonb_set(notification_preferences,'{push}','true') WHERE id=app.actor();
 RETURN result;
END $$;

CREATE FUNCTION app.queue_web_push() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 INSERT INTO app.push_outbox(notification_id,subscription_id)
 SELECT NEW.id,s.id FROM app.push_subscriptions s JOIN app.members m ON m.id=s.member_id
 WHERE s.member_id=NEW.recipient AND m.status IN('active','restricted') AND m.notification_preferences->>'push'='true'
 ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER notification_push AFTER INSERT ON app.notifications FOR EACH ROW EXECUTE FUNCTION app.queue_web_push();

CREATE FUNCTION app.revoke_disabled_push() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.status NOT IN('active','restricted') OR NEW.notification_preferences->>'push' IS DISTINCT FROM 'true' THEN
  DELETE FROM app.push_subscriptions WHERE member_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_push_disabled AFTER UPDATE OF status,notification_preferences ON app.members FOR EACH ROW EXECUTE FUNCTION app.revoke_disabled_push();

CREATE FUNCTION app.claim_push(batch_size integer DEFAULT 20) RETURNS TABLE(id uuid,lease uuid,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 DELETE FROM app.push_subscriptions s USING public.auth_session a WHERE s.session_id=a.id AND a."expiresAt"<=now();
 UPDATE app.push_outbox q SET completed_at=now(),outcome='expired' WHERE q.completed_at IS NULL AND (q.created_at<now()-interval '24 hours' OR q.attempts>=8) AND q.next_retry<=now();
 DELETE FROM app.push_outbox WHERE completed_at<now()-interval '7 days';
 RETURN QUERY UPDATE app.push_outbox q SET attempts=q.attempts+1,lease=gen_random_uuid(),next_retry=now()+interval '2 minutes'
 WHERE q.id IN(SELECT o.id FROM app.push_outbox o WHERE o.completed_at IS NULL AND o.next_retry<=now() ORDER BY o.next_retry,o.id LIMIT least(greatest(batch_size,1),100) FOR UPDATE SKIP LOCKED)
 RETURNING q.id,q.lease,q.attempts;
END $$;

-- Only the job role may run this recheck. It supplies no arbitrary recipient:
-- the identity is taken from the owned notification/subscription pair.
CREATE FUNCTION app.prepare_push(job uuid,token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE n app.notifications; s app.push_subscriptions; previous text; allowed boolean;
BEGIN
 SELECT x.* INTO s FROM app.push_subscriptions x JOIN app.push_outbox o ON o.subscription_id=x.id WHERE o.id=job AND o.lease=token AND o.completed_at IS NULL AND o.next_retry>now();
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT x.* INTO n FROM app.notifications x JOIN app.push_outbox o ON o.notification_id=x.id WHERE o.id=job;
 previous:=current_setting('app.member_id',true);
 PERFORM set_config('app.member_id',s.member_id::text,true);
 allowed:=n.id IS NOT NULL AND n.recipient=s.member_id AND n.read_at IS NULL AND app.may_read()
  AND EXISTS(SELECT FROM app.members m WHERE m.id=s.member_id AND m.notification_preferences->>'push'='true')
  AND EXISTS(SELECT FROM public.auth_session a WHERE a.id=s.session_id AND a."userId"=s.member_id::text AND a."expiresAt">now())
  AND(n.actor IS NULL OR(NOT app.blocked(n.actor,s.member_id) AND NOT EXISTS(SELECT FROM app.mutes WHERE actor=s.member_id AND target=n.actor)))
  AND(n.post_id IS NULL OR app.can_post(n.post_id))
  AND(n.comment_id IS NULL OR app.can_comment(n.comment_id))
  AND(n.group_id IS NULL OR app.in_group(n.group_id,s.member_id));
 PERFORM set_config('app.member_id',coalesce(previous,''),true);
 IF NOT coalesce(allowed,false) THEN
  UPDATE app.push_outbox SET completed_at=now(),outcome='unavailable' WHERE id=job AND lease=token;
  RETURN NULL;
 END IF;
 RETURN jsonb_build_object('endpoint',s.endpoint,'keys',jsonb_build_object('p256dh',s.p256dh,'auth',s.auth));
END $$;

CREATE FUNCTION app.finish_push(job uuid,token uuid,result text,delay_seconds integer DEFAULT 60) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF result='gone' THEN
  DELETE FROM app.push_subscriptions WHERE id IN(SELECT subscription_id FROM app.push_outbox WHERE id=job AND lease=token AND completed_at IS NULL);
 ELSIF result='retry' THEN
  UPDATE app.push_outbox SET next_retry=now()+least(greatest(delay_seconds,15),3600)*interval '1 second',lease=NULL WHERE id=job AND lease=token AND completed_at IS NULL;
 ELSIF result IN('sent','failed') THEN
  UPDATE app.push_outbox SET completed_at=now(),outcome=result,lease=NULL WHERE id=job AND lease=token AND completed_at IS NULL;
 ELSE RAISE EXCEPTION 'INVALID_PUSH_RESULT'; END IF;
END $$;

REVOKE ALL ON FUNCTION app.register_push(text,text,text,text),app.queue_web_push(),app.revoke_disabled_push(),app.claim_push(integer),app.prepare_push(uuid,uuid),app.finish_push(uuid,uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_push(text,text,text,text) TO porchday_social;
GRANT EXECUTE ON FUNCTION app.claim_push(integer),app.prepare_push(uuid,uuid),app.finish_push(uuid,uuid,text,integer) TO porchday_jobs;
