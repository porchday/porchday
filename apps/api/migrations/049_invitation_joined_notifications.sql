-- Checked once, including intentionally suppressed notices. A later unfriend or
-- preference change must not replay an old signup event.
ALTER TABLE public.platform_invitation_history ADD COLUMN notification_checked_at timestamptz;
CREATE INDEX invitation_history_unnotified ON public.platform_invitation_history(joined_at,id)
 WHERE joined_at IS NOT NULL AND claimed_user IS NOT NULL AND notification_checked_at IS NULL;

CREATE FUNCTION app.invitation_notice_eligible(invite_sender uuid,invitee uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT invite_sender<>invitee AND NOT app.blocked(invite_sender,invitee)
  AND NOT EXISTS(SELECT FROM app.connections WHERE member_a=least(invite_sender,invitee) AND member_b=greatest(invite_sender,invitee))
  AND NOT EXISTS(SELECT FROM app.mutes WHERE actor=invite_sender AND target=invitee)
  AND EXISTS(SELECT FROM app.members m JOIN public.auth_user u ON u.id=m.id::text
   WHERE m.id=invitee AND m.status IN('active','restricted') AND u."emailVerified")
  AND EXISTS(SELECT FROM app.members m WHERE m.id=invite_sender AND m.status IN('active','restricted')
   AND(m.notification_preferences->>'in_app'='true' OR m.notification_preferences->>'push'='true'))
$$;
CREATE FUNCTION app.invitation_notice_visible(joined uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.invitation_notice_eligible(app.actor(),joined)
$$;
REVOKE ALL ON FUNCTION app.invitation_notice_eligible(uuid,uuid),app.invitation_notice_visible(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_notice_visible(uuid) TO porchday_social;

CREATE FUNCTION app.process_invitation_joined_notices() RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE candidate record; receipt public.platform_invitation_history; checked integer:=0;
BEGIN
 FOR candidate IN
  SELECT h.id,s.id sender_id,j.id joined_id FROM public.platform_invitation_history h
   JOIN app.members s ON s.id::text=h.sender_id JOIN app.members j ON j.id::text=h.claimed_user
  WHERE h.joined_at IS NOT NULL AND h.notification_checked_at IS NULL AND h.requested_at>now()-interval '90 days'
  ORDER BY h.joined_at,h.id LIMIT 100
 LOOP
  -- Same order as connection acceptance/blocking: directory, members, receipt.
  -- Recheck after the locks so connecting concurrently cannot leave a stale notice.
  PERFORM app.lock_pair(candidate.sender_id,candidate.joined_id);
  SELECT * INTO receipt FROM public.platform_invitation_history WHERE id=candidate.id FOR UPDATE;
  IF NOT FOUND OR receipt.notification_checked_at IS NOT NULL OR receipt.claimed_user IS DISTINCT FROM candidate.joined_id::text THEN CONTINUE; END IF;
  UPDATE public.platform_invitation_history SET notification_checked_at=now() WHERE id=receipt.id;
  checked:=checked+1;
  IF app.invitation_notice_eligible(candidate.sender_id,candidate.joined_id) THEN
   INSERT INTO app.notifications(recipient,actor,kind,dedupe_key)
    VALUES(candidate.sender_id,candidate.joined_id,'invitation_joined','invitation-joined:'||candidate.sender_id||':'||candidate.joined_id)
    ON CONFLICT DO NOTHING;
  END IF;
 END LOOP;
 RETURN checked;
END $$;
REVOKE ALL ON FUNCTION app.process_invitation_joined_notices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.process_invitation_joined_notices() TO porchday_auth;

CREATE FUNCTION app.clear_connected_invitation_notices() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 DELETE FROM app.notifications WHERE kind='invitation_joined'
  AND((recipient=NEW.member_a AND actor=NEW.member_b) OR(recipient=NEW.member_b AND actor=NEW.member_a));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.clear_connected_invitation_notices() FROM PUBLIC;
CREATE TRIGGER clear_connected_invitation_notices AFTER INSERT ON app.connections
 FOR EACH ROW EXECUTE FUNCTION app.clear_connected_invitation_notices();

ALTER POLICY notifications_read ON app.notifications USING(
 recipient=app.actor() AND app.may_read() AND(actor IS NULL OR NOT app.blocked(actor,app.actor()))
 AND(post_id IS NULL OR app.can_post(post_id)) AND(comment_id IS NULL OR app.can_comment(comment_id))
 AND(group_id IS NULL OR app.in_group(group_id,app.actor()))
 AND(kind<>'invitation_joined' OR(app.invitation_notice_visible(actor)
  AND EXISTS(SELECT FROM app.members WHERE id=app.actor() AND notification_preferences->>'in_app'='true'))));

-- Only the inviter with a currently visible notice learns the new member's
-- handle. This grants no access to their encrypted profile, wall or keys.
CREATE OR REPLACE FUNCTION app.member_handles(ids uuid[]) RETURNS TABLE(id uuid,handle text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT p.member_id,p.handle FROM app.profiles p WHERE p.member_id=ANY(ids) AND app.may_read() AND NOT app.blocked(p.member_id,app.actor()) AND(p.member_id=app.actor() OR app.connected(p.member_id,app.actor()) OR EXISTS(SELECT FROM app.group_memberships a JOIN app.group_memberships b USING(group_id) WHERE a.member_id=app.actor() AND b.member_id=p.member_id) OR EXISTS(SELECT FROM app.connection_requests WHERE app.actor() IN(sender,recipient) AND p.member_id IN(sender,recipient)) OR EXISTS(SELECT FROM app.comments c WHERE c.author_id=p.member_id AND app.can_comment(c.id)) OR EXISTS(SELECT FROM app.notifications n WHERE n.recipient=app.actor() AND n.actor=p.member_id AND n.kind='invitation_joined' AND app.invitation_notice_visible(p.member_id) AND EXISTS(SELECT FROM app.members WHERE id=app.actor() AND notification_preferences->>'in_app'='true')))
$$;

-- Recheck the new notice at delivery time; keep the existing generic preview.
CREATE OR REPLACE FUNCTION app.prepare_push(job uuid,token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
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
 RETURN jsonb_build_object('endpoint',s.endpoint,'keys',jsonb_build_object('p256dh',s.p256dh,'auth',s.auth));
END $$;


-- Recheck the new notice at delivery time; keep the existing generic preview.
CREATE OR REPLACE FUNCTION app.prepare_native_push(job uuid,lease_token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
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
 RETURN jsonb_build_object('token',s.token,'environment',s.environment);
END $$;

