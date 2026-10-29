-- Bind independent denial checks to the same subscription row used for the
-- delivery payload. Never fetch the session ID in a separate snapshot/query.
-- Old preparation entry points retain their exact JSON shapes for rollback.
CREATE FUNCTION app.prepare_push_delivery(job uuid,token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
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
  AND(n.kind<>'invitation_joined' OR app.invitation_notice_visible(n.actor))
  AND(n.post_id IS NULL OR app.can_post(n.post_id))
  AND(n.comment_id IS NULL OR app.can_comment(n.comment_id))
  AND(n.group_id IS NULL OR app.in_group(n.group_id,s.member_id));
 PERFORM set_config('app.member_id',coalesce(previous,''),true);
 IF NOT coalesce(allowed,false) THEN
  UPDATE app.push_outbox SET completed_at=now(),outcome='unavailable' WHERE id=job AND lease=token;
  RETURN NULL;
 END IF;
 RETURN jsonb_build_object('sessionId',s.session_id,'subscription',jsonb_build_object('endpoint',s.endpoint,'keys',jsonb_build_object('p256dh',s.p256dh,'auth',s.auth)));
END $$;


-- Recheck the new notice at delivery time; keep the existing generic preview.
CREATE FUNCTION app.prepare_native_push_delivery(job uuid,lease_token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE n app.notifications; s app.native_push_subscriptions; previous text; allowed boolean;
BEGIN
 SELECT x.* INTO s FROM app.native_push_subscriptions x JOIN app.native_push_outbox o ON o.subscription_id=x.id WHERE o.id=job AND o.lease=lease_token AND o.completed_at IS NULL AND o.next_retry>now();
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT x.* INTO n FROM app.notifications x JOIN app.native_push_outbox o ON o.notification_id=x.id WHERE o.id=job;
 previous:=current_setting('app.member_id',true);
 PERFORM set_config('app.member_id',s.member_id::text,true);
 allowed:=n.id IS NOT NULL AND n.recipient=s.member_id AND n.read_at IS NULL AND app.may_read()
  AND EXISTS(SELECT FROM app.members m WHERE m.id=s.member_id AND m.notification_preferences->>'push'='true')
  AND EXISTS(SELECT FROM public.auth_session a WHERE a.id=s.session_id AND a."userId"=s.member_id::text AND a."expiresAt">now())
  AND(n.actor IS NULL OR(NOT app.blocked(n.actor,s.member_id) AND NOT EXISTS(SELECT FROM app.mutes WHERE actor=s.member_id AND target=n.actor)))
  AND(n.kind<>'invitation_joined' OR app.invitation_notice_visible(n.actor))
  AND(n.post_id IS NULL OR app.can_post(n.post_id))
  AND(n.comment_id IS NULL OR app.can_comment(n.comment_id))
  AND(n.group_id IS NULL OR app.in_group(n.group_id,s.member_id));
 PERFORM set_config('app.member_id',coalesce(previous,''),true);
 IF NOT coalesce(allowed,false) THEN
  UPDATE app.native_push_outbox SET completed_at=now(),outcome='unavailable' WHERE id=job AND lease=lease_token;
  RETURN NULL;
 END IF;
 RETURN jsonb_build_object('sessionId',s.session_id,'subscription',jsonb_build_object('token',s.token,'environment',s.environment));
END $$;


REVOKE ALL ON FUNCTION app.prepare_push_delivery(uuid,uuid),app.prepare_native_push_delivery(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prepare_push_delivery(uuid,uuid),app.prepare_native_push_delivery(uuid,uuid) TO porchday_jobs;

CREATE OR REPLACE FUNCTION app.prepare_push(job uuid,token uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.prepare_push_delivery(job,token)->'subscription'
$$;
CREATE OR REPLACE FUNCTION app.prepare_native_push(job uuid,lease_token uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.prepare_native_push_delivery(job,lease_token)->'subscription'
$$;
