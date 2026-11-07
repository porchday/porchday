-- Reader-first rollout: publication remains disabled until the reviewed workers
-- understand the new delivery metadata. Old inbox/queue readers remain compatible.
CREATE TABLE app.feed_notification_config(id boolean PRIMARY KEY DEFAULT true CHECK(id),enabled boolean NOT NULL DEFAULT false);
INSERT INTO app.feed_notification_config DEFAULT VALUES;
REVOKE ALL ON app.feed_notification_config FROM PUBLIC;
CREATE TABLE app.feed_activity (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 recipient uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 author_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 post_id uuid REFERENCES app.posts ON DELETE CASCADE,
 photo_id uuid REFERENCES app.photos ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 read_at timestamptz,
 CHECK(num_nonnulls(post_id,photo_id)=1),
 UNIQUE(recipient,post_id),UNIQUE(recipient,photo_id)
);
CREATE INDEX feed_activity_unread ON app.feed_activity(recipient,created_at) WHERE read_at IS NULL;
ALTER TABLE app.feed_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.feed_activity FORCE ROW LEVEL SECURITY;
ALTER TABLE app.notifications ADD COLUMN feed_activity_id uuid REFERENCES app.feed_activity ON DELETE CASCADE;
CREATE INDEX notifications_feed_activity ON app.notifications(feed_activity_id) WHERE feed_activity_id IS NOT NULL;

CREATE FUNCTION app.can_feed_activity(activity uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.may_read() AND EXISTS(SELECT FROM app.feed_activity f WHERE f.id=activity AND f.recipient=app.actor()
 AND app.connected(f.author_id,app.actor()) AND NOT app.blocked(f.author_id,app.actor())
 AND NOT EXISTS(SELECT FROM app.mutes WHERE actor=app.actor() AND target=f.author_id)
 AND CASE WHEN f.post_id IS NOT NULL THEN app.can_post(f.post_id)
 ELSE app.can_photo(f.photo_id) AND EXISTS(SELECT FROM app.photos p WHERE p.id=f.photo_id AND p.source_post_id IS NULL) END)
$$;
CREATE POLICY feed_activity_read ON app.feed_activity FOR SELECT USING(app.can_feed_activity(id));
GRANT SELECT ON app.feed_activity TO porchday_social;
CREATE FUNCTION app.feed_unread_state() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT jsonb_build_object('count',count(*),'observed_at',clock_timestamp()) FROM app.feed_activity f
 WHERE f.recipient=app.actor() AND f.read_at IS NULL AND app.can_feed_activity(f.id)
$$;

-- Capture only the recipients of the original publication, after its encrypted
-- recipients and photo-source linkage have been installed in the transaction.
-- No grant/history/album update trigger exists, so history cannot create alerts.
CREATE FUNCTION app.publish_feed_activity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE author uuid; recipient_id uuid; previous text:=current_setting('app.member_id',true); activity uuid; is_post boolean:=TG_TABLE_NAME='posts';
BEGIN
 IF current_setting('app.restore_replay',true)='on' OR NOT EXISTS(SELECT FROM app.feed_notification_config WHERE enabled) THEN RETURN NULL;END IF;
 IF is_post THEN
  SELECT author_id INTO author FROM app.posts WHERE id=NEW.id AND import_source IS NULL AND group_id IS NULL AND(expires_at IS NULL OR expires_at>statement_timestamp());
 ELSE
  SELECT owner_id INTO author FROM app.photos WHERE id=NEW.id AND source_post_id IS NULL AND(expires_at IS NULL OR expires_at>statement_timestamp());
 END IF;
 IF author IS NULL THEN RETURN NULL;END IF;
 FOR recipient_id IN
  SELECT DISTINCT member_id FROM app.post_recipients WHERE is_post AND post_id=NEW.id
  UNION SELECT DISTINCT r.member_id FROM app.photo_grant_recipients r JOIN app.photo_grants g ON g.id=r.grant_id WHERE NOT is_post AND g.photo_id=NEW.id
 LOOP
  IF recipient_id=author OR NOT app.connected(author,recipient_id) OR app.blocked(author,recipient_id) THEN CONTINUE;END IF;
  PERFORM set_config('app.member_id',recipient_id::text,true);
  IF NOT app.may_read() OR EXISTS(SELECT FROM app.mutes m WHERE m.actor=recipient_id AND m.target=author)
   OR NOT (CASE WHEN is_post THEN app.can_post(NEW.id) ELSE app.can_photo(NEW.id) END) THEN CONTINUE;END IF;
  activity:=NULL;
  INSERT INTO app.feed_activity(recipient,author_id,post_id,photo_id) VALUES(recipient_id,author,CASE WHEN is_post THEN NEW.id END,CASE WHEN NOT is_post THEN NEW.id END)
   ON CONFLICT DO NOTHING RETURNING id INTO activity;
  IF activity IS NOT NULL THEN
   INSERT INTO app.notifications(recipient,actor,kind,post_id,feed_activity_id,dedupe_key)
    VALUES(recipient_id,author,'feed_activity',CASE WHEN is_post THEN NEW.id END,activity,'feed:'||activity) ON CONFLICT DO NOTHING;
  END IF;
 END LOOP;
 PERFORM set_config('app.member_id',coalesce(previous,''),true);
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER feed_post_published AFTER INSERT ON app.posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.publish_feed_activity();
CREATE CONSTRAINT TRIGGER feed_photo_published AFTER INSERT ON app.photos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.publish_feed_activity();

CREATE FUNCTION app.mark_feed_read(items jsonb,all_visible boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE changed integer;
BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF jsonb_typeof(items)<>'array' OR jsonb_array_length(items)>100 THEN RAISE EXCEPTION 'INVALID_BATCH';END IF;
 -- One MVCC statement snapshot: publications concurrent with this update remain
 -- unread. There is no client-supplied future timestamp or global high-water ID.
 UPDATE app.feed_activity f SET read_at=clock_timestamp() WHERE f.recipient=app.actor() AND f.read_at IS NULL AND app.can_feed_activity(f.id)
 AND(all_visible OR EXISTS(SELECT FROM jsonb_array_elements(items) x WHERE (x->>'kind'='post' AND f.post_id=(x->>'id')::uuid) OR(x->>'kind'='photo' AND f.photo_id=(x->>'id')::uuid)));
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN
  INSERT INTO app.notifications(recipient,kind) VALUES(app.actor(),'feed_badge');
 END IF;
 RETURN app.feed_unread_state();
END $$;
REVOKE ALL ON FUNCTION app.can_feed_activity(uuid),app.feed_unread_state(),app.mark_feed_read(jsonb,boolean),app.publish_feed_activity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_feed_activity(uuid),app.feed_unread_state(),app.mark_feed_read(jsonb,boolean) TO porchday_social;

-- Feed alerts live in Feed, not the unrelated inbox. Counts never depend on the
-- notification preferences or on whether an inbox notification was dismissed.
CREATE POLICY notifications_feed_hidden ON app.notifications AS RESTRICTIVE FOR SELECT USING(kind NOT IN('feed_activity','feed_badge'));

-- Web Push requires user-visible alerts; do not send silent badge-only pushes.
-- Native APNs can update the badge without showing another alert.
DO $migration$
DECLARE definition text; needle text:='BEGIN';
BEGIN
 SELECT pg_get_functiondef('app.queue_web_push()'::regprocedure) INTO definition;
 EXECUTE replace(definition,needle,needle||E'\n IF NEW.kind=''feed_badge'' THEN RETURN NULL;END IF;');
END $migration$;

-- Keep old prepare entry points intact. Add authorization and metadata to the
-- reader functions used by current workers; older workers ignore extra fields.
DO $migration$
DECLARE name text;definition text;needle text;
BEGIN
 FOREACH name IN ARRAY ARRAY['prepare_push_delivery','prepare_native_push_delivery'] LOOP
  SELECT pg_get_functiondef(('app.'||name||'(uuid,uuid)')::regprocedure) INTO definition;
  needle:='AND(n.group_id IS NULL OR app.in_group(n.group_id,s.member_id));';
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_PUSH_READER';END IF;
  definition:=replace(definition,needle,$new$AND(n.group_id IS NULL OR app.in_group(n.group_id,s.member_id))
  AND(n.feed_activity_id IS NULL OR(app.can_feed_activity(n.feed_activity_id) AND EXISTS(SELECT FROM app.feed_activity f WHERE f.id=n.feed_activity_id AND f.read_at IS NULL)));$new$);
  -- Capture the count while acting as the intended recipient, before restoring
  -- the jobs caller. Add a local variable instead of exposing an arbitrary-user API.
  definition:=replace(definition,'allowed boolean;','allowed boolean; feed_state jsonb;');
  definition:=replace(definition,'PERFORM set_config(''app.member_id'',coalesce(previous,''''),true);',
   'feed_state:=app.feed_unread_state(); PERFORM set_config(''app.member_id'',coalesce(previous,''''),true);');
  definition:=replace(definition,'RETURN jsonb_build_object(''sessionId'',s.session_id,',
   'RETURN jsonb_build_object(''feed'',jsonb_build_object(''count'',feed_state->''count'',''kind'',n.kind,''id'',n.id),''sessionId'',s.session_id,');
  EXECUTE definition;
 END LOOP;
END $migration$;
