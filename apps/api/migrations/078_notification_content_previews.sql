-- Encrypted preview material only. No post text, caption or JPEG plaintext.
CREATE TABLE app.notification_preview_keys (
 id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 device_id uuid NOT NULL REFERENCES app.device_keys ON DELETE CASCADE,
 session_id text NOT NULL REFERENCES public.auth_session ON DELETE CASCADE,
 web_subscription uuid UNIQUE REFERENCES app.push_subscriptions ON DELETE CASCADE,
 native_subscription uuid UNIQUE REFERENCES app.native_push_subscriptions ON DELETE CASCADE,
 certificate jsonb NOT NULL CHECK(octet_length(certificate::text)<16000),
 CHECK(num_nonnulls(web_subscription,native_subscription)=1)
);
ALTER TABLE app.notification_preview_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY preview_key_owner ON app.notification_preview_keys FOR ALL USING(member_id=app.actor() AND app.may_read()) WITH CHECK(member_id=app.actor() AND app.may_read()
 AND EXISTS(SELECT FROM app.device_keys d WHERE d.id=device_id AND d.member_id=app.actor() AND d.revoked_at IS NULL)
 AND (EXISTS(SELECT FROM app.push_subscriptions s WHERE s.id=web_subscription AND s.member_id=app.actor() AND s.session_id=notification_preview_keys.session_id)
 OR EXISTS(SELECT FROM app.native_push_subscriptions s WHERE s.id=native_subscription AND s.member_id=app.actor() AND s.session_id=notification_preview_keys.session_id)));
GRANT SELECT,INSERT,DELETE ON app.notification_preview_keys TO porchday_social;
CREATE TABLE app.notification_previews (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 post_id uuid UNIQUE REFERENCES app.posts ON DELETE CASCADE,
 photo_id uuid UNIQUE REFERENCES app.photos ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision>0), signed_preview jsonb NOT NULL CHECK(octet_length(signed_preview::text)<1000000),
 CHECK(num_nonnulls(post_id,photo_id)=1)
);
ALTER TABLE app.notification_previews ENABLE ROW LEVEL SECURITY;
CREATE POLICY preview_owner ON app.notification_previews FOR ALL USING(owner_id=app.actor() AND app.may_read()) WITH CHECK(owner_id=app.actor() AND app.may_read()
 AND (EXISTS(SELECT FROM app.posts p WHERE p.id=post_id AND p.author_id=app.actor())
 OR EXISTS(SELECT FROM app.photos p WHERE p.id=photo_id AND p.owner_id=app.actor())));
GRANT SELECT,INSERT,DELETE ON app.notification_previews TO porchday_social;
CREATE TABLE app.notification_preview_tickets (
 token_hash text PRIMARY KEY, notification_id uuid NOT NULL REFERENCES app.notifications ON DELETE CASCADE,
 key_id uuid NOT NULL REFERENCES app.notification_preview_keys ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, UNIQUE(notification_id,key_id)
);
CREATE INDEX notification_preview_tickets_expiry ON app.notification_preview_tickets(expires_at);
REVOKE ALL ON app.notification_preview_tickets FROM PUBLIC;

CREATE FUNCTION app.preview_recipient_keys(devices uuid[]) RETURNS TABLE(id uuid,member_id uuid,device_id uuid,certificate jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT k.id,k.member_id,k.device_id,k.certificate FROM app.notification_preview_keys k JOIN app.device_keys d ON d.id=k.device_id
 JOIN public.auth_session s ON s.id=k.session_id
 WHERE app.may_read() AND cardinality(devices)<=4000 AND k.device_id=ANY(devices)
 AND d.member_id=k.member_id AND d.revoked_at IS NULL AND s."expiresAt">now()
 AND NOT app.blocked(k.member_id,app.actor())
 AND EXISTS(SELECT FROM app.members m WHERE m.id=k.member_id AND m.notification_preferences->>'push'='true')
$$;
REVOKE ALL ON FUNCTION app.preview_recipient_keys(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.preview_recipient_keys(uuid[]) TO porchday_social;

CREATE FUNCTION app.issue_notification_preview(notice uuid,subscription uuid,native boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE k app.notification_preview_keys; n app.notifications; f app.feed_activity; p app.notification_previews; token text;
BEGIN
 SELECT * INTO n FROM app.notifications WHERE id=notice AND kind='feed_activity';
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO f FROM app.feed_activity WHERE id=n.feed_activity_id;
 SELECT * INTO k FROM app.notification_preview_keys WHERE member_id=n.recipient AND CASE WHEN native THEN native_subscription=subscription ELSE web_subscription=subscription END;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO p FROM app.notification_previews WHERE post_id=f.post_id OR photo_id=f.photo_id;
 IF NOT FOUND OR NOT EXISTS(SELECT FROM jsonb_array_elements(p.signed_preview->'statement'->'recipients') r WHERE r->>'keyId'=k.id::text AND r->>'memberId'=k.member_id::text AND r->>'deviceId'=k.device_id::text) THEN RETURN NULL;END IF;
 token:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
 DELETE FROM app.notification_preview_tickets WHERE token_hash IN(SELECT token_hash FROM app.notification_preview_tickets WHERE expires_at<=now() LIMIT 100);
 INSERT INTO app.notification_preview_tickets(token_hash,notification_id,key_id,expires_at) VALUES(encode(sha256(convert_to(token,'UTF8')),'hex'),n.id,k.id,now()+interval '10 minutes')
 ON CONFLICT(notification_id,key_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at;
 RETURN jsonb_build_object('token',token,'keyId',k.id);
END $$;
REVOKE ALL ON FUNCTION app.issue_notification_preview(uuid,uuid,boolean) FROM PUBLIC;

CREATE FUNCTION app.redeem_notification_preview(hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE t app.notification_preview_tickets;k app.notification_preview_keys;n app.notifications;f app.feed_activity;p app.notification_previews;previous text:=current_setting('app.member_id',true);allowed boolean;author_key jsonb;
BEGIN
 SELECT * INTO t FROM app.notification_preview_tickets WHERE token_hash=hash AND expires_at>now();IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO k FROM app.notification_preview_keys WHERE id=t.key_id;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO n FROM app.notifications WHERE id=t.notification_id AND recipient=k.member_id AND read_at IS NULL;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO f FROM app.feed_activity WHERE id=n.feed_activity_id AND read_at IS NULL;IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO p FROM app.notification_previews WHERE post_id=f.post_id OR photo_id=f.photo_id;IF NOT FOUND THEN RETURN NULL;END IF;
 PERFORM set_config('app.member_id',k.member_id::text,true);
 allowed:=app.can_feed_activity(f.id) AND app.may_read()
 AND EXISTS(SELECT FROM public.auth_session s WHERE s.id=k.session_id AND s."userId"=k.member_id::text AND s."expiresAt">now())
 AND EXISTS(SELECT FROM app.device_keys d WHERE d.id=k.device_id AND d.member_id=k.member_id AND d.revoked_at IS NULL)
 AND EXISTS(SELECT FROM app.members m WHERE m.id=k.member_id AND m.notification_preferences->>'push'='true')
 AND (EXISTS(SELECT FROM app.push_subscriptions s WHERE s.id=k.web_subscription AND s.session_id=k.session_id AND s.member_id=k.member_id) OR EXISTS(SELECT FROM app.native_push_subscriptions s WHERE s.id=k.native_subscription AND s.session_id=k.session_id AND s.member_id=k.member_id))
 AND CASE WHEN p.post_id IS NOT NULL THEN EXISTS(SELECT FROM app.posts x WHERE x.id=p.post_id AND (x.envelope->'context'->>'revision')::integer=p.revision AND EXISTS(SELECT FROM app.post_recipients r WHERE r.post_id=x.id AND r.device_id=k.device_id AND r.member_id=k.member_id))
 ELSE EXISTS(SELECT FROM app.photos x WHERE x.id=p.photo_id AND x.revision=p.revision AND EXISTS(SELECT FROM app.photo_grants g JOIN app.photo_grant_recipients r ON r.grant_id=g.id WHERE g.photo_id=x.id AND r.member_id=k.member_id AND app.can_photo_grant(g.id) AND EXISTS(SELECT FROM jsonb_array_elements(g.envelope->'recipients') er WHERE er->>'deviceId'=k.device_id::text AND er->>'memberId'=k.member_id::text))) END;
 SELECT to_jsonb(d) INTO author_key FROM app.author_key((p.signed_preview->'statement'->'context'->>'authorDeviceId')::uuid) d;
 PERFORM set_config('app.member_id',coalesce(previous,''),true);
 IF NOT coalesce(allowed,false) OR author_key IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('sessionId',k.session_id,'signed',p.signed_preview,'identity',k.certificate->'statement','author_key',author_key,'context',p.signed_preview->'statement'->'context');
END $$;
REVOKE ALL ON FUNCTION app.redeem_notification_preview(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redeem_notification_preview(text) TO porchday_social;

-- Called only after existing delivery-time authorization; old clients ignore it.
DO $migration$
DECLARE name text;definition text;needle text:='''content'',CASE WHEN n.post_id IS NOT NULL THEN ''post'' ELSE ''media'' END)';
BEGIN
 FOREACH name IN ARRAY ARRAY['prepare_push_delivery','prepare_native_push_delivery'] LOOP
  SELECT pg_get_functiondef(('app.'||name||'(uuid,uuid)')::regprocedure) INTO definition;
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_PREVIEW_DELIVERY_READER';END IF;
  definition:=replace(definition,needle,'''content'',CASE WHEN n.post_id IS NOT NULL THEN ''post'' ELSE ''media'' END,''preview'',app.issue_notification_preview(n.id,s.id,'||CASE WHEN name='prepare_native_push_delivery' THEN 'true' ELSE 'false' END||'))');
  EXECUTE definition;
 END LOOP;
END $migration$;
