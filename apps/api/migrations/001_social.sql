-- Porchday social metadata. Content and recipient private keys never enter SQL.
CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE app.members (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','restricted','suspended','hold','deleting','deleted')),
  adult_attested_at timestamptz NOT NULL,
  rules_accepted_at timestamptz NOT NULL,
  notification_preferences jsonb NOT NULL DEFAULT '{"in_app":true,"push":false}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.directory_epoch (id boolean PRIMARY KEY DEFAULT true CHECK(id), epoch bigint NOT NULL DEFAULT 1);
INSERT INTO app.directory_epoch(id) VALUES(true);
CREATE TABLE app.profiles (
  member_id uuid PRIMARY KEY REFERENCES app.members ON DELETE CASCADE,
  handle text NOT NULL UNIQUE CHECK(handle ~ '^[a-z0-9_]{3,24}$'),
  envelope jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.device_keys (
  id uuid PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  public_key text NOT NULL CHECK(length(public_key) BETWEEN 100 AND 30000),
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-fA-F0-9]{40,64}$'),
  authorization_proof jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(member_id,fingerprint)
);
CREATE TABLE app.encrypted_key_backups (
  member_id uuid PRIMARY KEY REFERENCES app.members ON DELETE CASCADE,
  envelope jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.connection_requests (
  id uuid PRIMARY KEY,
  sender uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  recipient uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('friend','family')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','declined','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(sender<>recipient)
);
CREATE UNIQUE INDEX request_one_pending_pair ON app.connection_requests(least(sender,recipient),greatest(sender,recipient)) WHERE state='pending';
CREATE TABLE app.connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_a uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  member_b uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('friend','family')),
  proposed_kind text CHECK(proposed_kind IN ('friend','family')),
  proposed_by uuid REFERENCES app.members ON DELETE SET NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CHECK(member_a<member_b), UNIQUE(member_a,member_b)
);
CREATE INDEX connections_b ON app.connections(member_b);
CREATE TABLE app.blocks (
  actor uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  target uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor,target), CHECK(actor<>target)
);
CREATE TABLE app.mutes (
  actor uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  target uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor,target), CHECK(actor<>target)
);
CREATE TABLE app.groups (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.members,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.group_memberships (
  group_id uuid NOT NULL REFERENCES app.groups ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  role text NOT NULL CHECK(role IN ('owner','moderator','member')),
  joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(group_id,member_id)
);
CREATE INDEX group_memberships_member ON app.group_memberships(member_id);
CREATE TABLE app.group_invitations (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES app.groups ON DELETE CASCADE,
  inviter uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  recipient uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  envelope jsonb,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  accepted_at timestamptz,
  UNIQUE(group_id,recipient)
);
CREATE TABLE app.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  group_id uuid REFERENCES app.groups ON DELETE CASCADE,
  audience text NOT NULL CHECK(audience IN ('connections','family','only_me','group')),
  envelope jsonb NOT NULL,
  epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  expires_at timestamptz,
  import_source text,
  CHECK((audience='group')=(group_id IS NOT NULL)),
  CHECK(expires_at IS NULL OR expires_at>created_at)
);
CREATE UNIQUE INDEX posts_import_unique ON app.posts(author_id,import_source) WHERE import_source IS NOT NULL;
CREATE INDEX posts_author_cursor ON app.posts(author_id,created_at DESC,id DESC);
CREATE INDEX posts_group_cursor ON app.posts(group_id,created_at DESC,id DESC);
CREATE INDEX posts_expiry ON app.posts(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE app.post_recipients (
  post_id uuid NOT NULL REFERENCES app.posts ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES app.device_keys ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  PRIMARY KEY(post_id,device_id)
);
CREATE TABLE app.comments (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES app.posts ON DELETE CASCADE,
  parent_id uuid,
  author_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  expires_at timestamptz,
  UNIQUE(id,post_id),
  FOREIGN KEY(parent_id,post_id) REFERENCES app.comments(id,post_id) ON DELETE CASCADE,
  CHECK(parent_id IS NULL OR parent_id<>id),
  CHECK(expires_at IS NULL OR expires_at>created_at)
);
CREATE INDEX comments_post ON app.comments(post_id,created_at,id);
CREATE INDEX comments_parent ON app.comments(parent_id);
CREATE INDEX comments_expiry ON app.comments(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE app.post_reactions (
  post_id uuid NOT NULL REFERENCES app.posts ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  reaction_tag text NOT NULL CHECK(reaction_tag ~ '^[A-Za-z0-9_-]{16,128}$'),
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(post_id,member_id,reaction_tag)
);
CREATE TABLE app.comment_reactions (
  comment_id uuid NOT NULL REFERENCES app.comments ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  reaction_tag text NOT NULL CHECK(reaction_tag ~ '^[A-Za-z0-9_-]{16,128}$'),
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(comment_id,member_id,reaction_tag)
);
CREATE TABLE app.media_assets (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  post_id uuid REFERENCES app.posts ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  envelope jsonb NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 22020096),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','attached')),
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_post ON app.media_assets(post_id);
CREATE TABLE app.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  actor uuid REFERENCES app.members ON DELETE CASCADE,
  kind text NOT NULL,
  post_id uuid REFERENCES app.posts ON DELETE CASCADE,
  comment_id uuid REFERENCES app.comments ON DELETE CASCADE,
  group_id uuid REFERENCES app.groups ON DELETE CASCADE,
  dedupe_key text UNIQUE,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_recipient ON app.notifications(recipient,created_at DESC);
CREATE TABLE app.reports (
  id uuid PRIMARY KEY,
  reporter uuid REFERENCES app.members ON DELETE SET NULL,
  target_member uuid REFERENCES app.members ON DELETE SET NULL,
  target_id uuid,
  reason text NOT NULL CHECK(reason IN ('harassment','impersonation','spam','agent','safety','other','appeal')),
  evidence_envelope jsonb,
  evidence_disclosed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','reviewing','resolved','appealed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_until timestamptz NOT NULL DEFAULT now()+interval '90 days',
  CHECK(evidence_envelope IS NULL OR evidence_disclosed)
);
CREATE TABLE app.moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid REFERENCES app.reports ON DELETE SET NULL,
  staff_id uuid NOT NULL,
  member_id uuid REFERENCES app.members ON DELETE SET NULL,
  action text NOT NULL,
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.integration_clients (
  id uuid PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  redirect_uri text NOT NULL CHECK(redirect_uri LIKE 'https://%' OR redirect_uri LIKE 'http://127.0.0.1:%'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.integration_grants (
  id uuid PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES app.integration_clients ON DELETE CASCADE,
  scopes text[] NOT NULL,
  code_hash text UNIQUE,
  code_challenge text NOT NULL,
  code_expires_at timestamptz NOT NULL,
  access_hash text UNIQUE,
  refresh_hash text UNIQUE,
  access_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(scopes<@ARRAY['profile:read','content:read','media:read','export:read']::text[])
);
CREATE TABLE app.data_transfer_jobs (
  id uuid PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('export','import')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete','cancelled','invalidated','failed')),
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour'
);
CREATE TABLE app.deletion_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_key text NOT NULL UNIQUE,
  reason text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_retry timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deletion_pending ON app.deletion_outbox(next_retry) WHERE completed_at IS NULL;
CREATE TABLE app.deletion_ledger (
  kind text NOT NULL,
  object_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(kind,object_id)
);

CREATE FUNCTION app.actor() RETURNS uuid LANGUAGE plpgsql STABLE SET search_path=pg_catalog,app AS $$
DECLARE raw text:=current_setting('app.member_id',true);
BEGIN
  IF raw IS NULL OR raw !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN NULL; END IF;
  RETURN raw::uuid;
END $$;
CREATE FUNCTION app.may_read() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT EXISTS(SELECT FROM app.members WHERE id=app.actor() AND status IN ('active','restricted')) $$;
CREATE FUNCTION app.may_write() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT EXISTS(SELECT FROM app.members WHERE id=app.actor() AND status='active') $$;
CREATE FUNCTION app.blocked(a uuid,b uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT EXISTS(SELECT FROM app.blocks WHERE (actor=a AND target=b) OR (actor=b AND target=a)) $$;
CREATE FUNCTION app.connected(a uuid,b uuid,family boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT EXISTS(SELECT FROM app.connections WHERE member_a=least(a,b) AND member_b=greatest(a,b) AND (NOT family OR kind='family')) AND NOT app.blocked(a,b) $$;
CREATE FUNCTION app.in_group(g uuid,m uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT EXISTS(SELECT FROM app.group_memberships WHERE group_id=g AND member_id=m) $$;
CREATE FUNCTION app.group_manager(g uuid,m uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT EXISTS(SELECT FROM app.group_memberships WHERE group_id=g AND member_id=m AND role IN ('owner','moderator')) $$;
CREATE FUNCTION app.can_profile(m uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT app.may_read() AND (m=app.actor() OR app.connected(m,app.actor())) $$;
CREATE FUNCTION app.can_post(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.may_read() AND EXISTS(SELECT FROM app.posts p0 WHERE p0.id=p AND (p0.expires_at IS NULL OR p0.expires_at>statement_timestamp()) AND NOT app.blocked(p0.author_id,app.actor()) AND (
 p0.author_id=app.actor() OR (EXISTS(SELECT FROM app.post_recipients r WHERE r.post_id=p AND r.member_id=app.actor()) AND (
 (p0.audience='connections' AND app.connected(p0.author_id,app.actor())) OR
 (p0.audience='family' AND app.connected(p0.author_id,app.actor(),true)) OR
 (p0.audience='group' AND app.in_group(p0.group_id,app.actor()))))))
$$;
CREATE FUNCTION app.comment_deadline(c uuid) RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 WITH RECURSIVE chain AS (SELECT id,parent_id,post_id,expires_at FROM app.comments WHERE id=c UNION ALL SELECT t.id,t.parent_id,t.post_id,t.expires_at FROM app.comments t JOIN chain ON chain.parent_id=t.id)
 SELECT least((SELECT min(expires_at) FROM chain),(SELECT p.expires_at FROM app.posts p WHERE p.id=(SELECT post_id FROM chain LIMIT 1)))
$$;
CREATE FUNCTION app.can_comment(c uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT FROM app.comments WHERE id=c AND app.can_post(post_id) AND NOT app.blocked(author_id,app.actor()) AND (app.comment_deadline(c) IS NULL OR app.comment_deadline(c)>statement_timestamp()))
$$;
CREATE FUNCTION app.can_delete_post(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT app.may_write() AND EXISTS(SELECT FROM app.posts WHERE id=p AND (author_id=app.actor() OR app.group_manager(group_id,app.actor()))) $$;
CREATE FUNCTION app.can_delete_comment(c uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT app.may_write() AND EXISTS(SELECT FROM app.comments c0 JOIN app.posts p ON p.id=c0.post_id WHERE c0.id=c AND (c0.author_id=app.actor() OR p.author_id=app.actor() OR app.group_manager(p.group_id,app.actor()))) $$;

-- Security-sensitive relationship writes use one lock order, including blocks.
CREATE FUNCTION app.lock_pair(a uuid,b uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 PERFORM 1 FROM app.members WHERE id IN(a,b) ORDER BY id FOR UPDATE;
END $$;
CREATE FUNCTION app.accept_connection(request_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r app.connection_requests; result uuid;
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO r FROM app.connection_requests WHERE id=request_id;
 IF r.recipient IS DISTINCT FROM app.actor() THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM app.lock_pair(r.sender,r.recipient);
 SELECT * INTO r FROM app.connection_requests WHERE id=request_id FOR UPDATE;
 IF r.state='accepted' THEN SELECT id INTO result FROM app.connections WHERE member_a=least(r.sender,r.recipient) AND member_b=greatest(r.sender,r.recipient); RETURN result; END IF;
 IF r.state<>'pending' OR app.blocked(r.sender,r.recipient) OR NOT EXISTS(SELECT FROM app.members WHERE id=r.sender AND status='active') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF (SELECT count(*) FROM app.connections WHERE r.sender IN(member_a,member_b))>=300 OR (SELECT count(*) FROM app.connections WHERE r.recipient IN(member_a,member_b))>=300 THEN RAISE EXCEPTION 'CONNECTION_LIMIT'; END IF;
 INSERT INTO app.connections(member_a,member_b,kind) VALUES(least(r.sender,r.recipient),greatest(r.sender,r.recipient),r.kind) RETURNING id INTO result;
 UPDATE app.connection_requests SET state='accepted' WHERE id=request_id;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 INSERT INTO app.notifications(recipient,actor,kind,dedupe_key) VALUES(r.sender,r.recipient,'connection_accepted','connection:'||request_id) ON CONFLICT DO NOTHING;
 RETURN result;
END $$;
CREATE FUNCTION app.change_connection(connection_id uuid,new_kind text,remove boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r app.connections;
BEGIN
 IF NOT app.may_write() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO r FROM app.connections WHERE id=connection_id;
 IF app.actor() NOT IN(r.member_a,r.member_b) OR r.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM app.lock_pair(r.member_a,r.member_b);
 SELECT * INTO r FROM app.connections WHERE id=connection_id FOR UPDATE;
 IF remove THEN DELETE FROM app.connections WHERE id=connection_id;
 ELSIF new_kind NOT IN('friend','family') THEN RAISE EXCEPTION 'INVALID_KIND';
 ELSIF r.proposed_kind=new_kind AND r.proposed_by<>app.actor() THEN UPDATE app.connections SET kind=new_kind,proposed_kind=NULL,proposed_by=NULL WHERE id=connection_id;
 ELSIF r.kind<>new_kind THEN UPDATE app.connections SET proposed_kind=new_kind,proposed_by=app.actor() WHERE id=connection_id;
 ELSE UPDATE app.connections SET proposed_kind=NULL,proposed_by=NULL WHERE id=connection_id; END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
END $$;
CREATE FUNCTION app.set_block(other uuid,enabled boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NOT app.may_read() OR app.actor()=other THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM app.lock_pair(app.actor(),other);
 IF enabled THEN
 INSERT INTO app.blocks(actor,target) VALUES(app.actor(),other) ON CONFLICT DO NOTHING;
 DELETE FROM app.connections WHERE member_a=least(app.actor(),other) AND member_b=greatest(app.actor(),other);
 UPDATE app.connection_requests SET state='cancelled' WHERE state='pending' AND least(sender,recipient)=least(app.actor(),other) AND greatest(sender,recipient)=greatest(app.actor(),other);
 DELETE FROM app.notifications WHERE (actor=other AND recipient=app.actor()) OR(actor=app.actor() AND recipient=other);
 ELSE DELETE FROM app.blocks WHERE actor=app.actor() AND target=other; END IF;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
END $$;
CREATE FUNCTION app.immutable_comment_parent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$ BEGIN
 IF NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.post_id<>OLD.post_id OR NEW.author_id<>OLD.author_id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'IMMUTABLE_CONTEXT'; END IF;
 IF OLD.expires_at IS NOT NULL AND(NEW.expires_at IS NULL OR NEW.expires_at>OLD.expires_at) THEN RAISE EXCEPTION 'EXPIRY_CANNOT_EXTEND'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER comments_immutable BEFORE UPDATE ON app.comments FOR EACH ROW EXECUTE FUNCTION app.immutable_comment_parent();
CREATE FUNCTION app.immutable_post_context() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$ BEGIN
 IF NEW.author_id<>OLD.author_id OR NEW.audience<>OLD.audience OR NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'IMMUTABLE_CONTEXT'; END IF;
 IF OLD.expires_at IS NOT NULL AND(NEW.expires_at IS NULL OR NEW.expires_at>OLD.expires_at) THEN RAISE EXCEPTION 'EXPIRY_CANNOT_EXTEND'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER posts_immutable BEFORE UPDATE ON app.posts FOR EACH ROW EXECUTE FUNCTION app.immutable_post_context();
CREATE FUNCTION app.record_content_deletion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 INSERT INTO app.deletion_ledger(kind,object_id) VALUES(TG_TABLE_NAME,OLD.id) ON CONFLICT DO NOTHING;
 UPDATE app.data_transfer_jobs SET state='invalidated' WHERE member_id=OLD.author_id AND kind='export' AND state IN('pending','complete');
 RETURN OLD;
END $$;
CREATE TRIGGER post_deletion BEFORE DELETE ON app.posts FOR EACH ROW EXECUTE FUNCTION app.record_content_deletion();
CREATE TRIGGER comment_deletion BEFORE DELETE ON app.comments FOR EACH ROW EXECUTE FUNCTION app.record_content_deletion();
CREATE FUNCTION app.enqueue_media_deletion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 INSERT INTO app.deletion_outbox(object_key,reason) VALUES(OLD.object_key,'media_deleted') ON CONFLICT DO NOTHING;
 INSERT INTO app.deletion_ledger(kind,object_id) VALUES('media_assets',OLD.id) ON CONFLICT DO NOTHING;
 RETURN OLD;
END $$;
CREATE TRIGGER media_deletion BEFORE DELETE ON app.media_assets FOR EACH ROW EXECUTE FUNCTION app.enqueue_media_deletion();

-- RLS is applied even where the HTTP service already checked authorization.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['members','profiles','device_keys','encrypted_key_backups','connection_requests','connections','blocks','mutes','groups','group_memberships','group_invitations','posts','post_recipients','comments','post_reactions','comment_reactions','media_assets','notifications','reports','moderation_actions','integration_clients','integration_grants','data_transfer_jobs','deletion_outbox','deletion_ledger','directory_epoch'] LOOP
 EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
 END LOOP;
END $$;
CREATE POLICY members_self ON app.members FOR SELECT USING(id=app.actor());
CREATE POLICY members_preferences ON app.members FOR UPDATE USING(id=app.actor() AND app.may_read()) WITH CHECK(id=app.actor());
CREATE POLICY profiles_read ON app.profiles FOR SELECT USING(app.can_profile(member_id));
CREATE POLICY profiles_write ON app.profiles FOR UPDATE USING(member_id=app.actor() AND app.may_write());
CREATE POLICY devices_read ON app.device_keys FOR SELECT USING(app.may_read() AND (member_id=app.actor() OR revoked_at IS NULL));
CREATE POLICY devices_write ON app.device_keys FOR ALL USING(member_id=app.actor() AND app.may_write()) WITH CHECK(member_id=app.actor() AND app.may_write());
CREATE POLICY backups_self ON app.encrypted_key_backups FOR ALL USING(member_id=app.actor() AND app.may_read()) WITH CHECK(member_id=app.actor() AND app.may_write());
CREATE POLICY requests_read ON app.connection_requests FOR SELECT USING(app.may_read() AND app.actor() IN(sender,recipient));
CREATE POLICY requests_create ON app.connection_requests FOR INSERT WITH CHECK(sender=app.actor() AND app.may_write() AND NOT app.blocked(sender,recipient));
CREATE POLICY requests_update ON app.connection_requests FOR UPDATE USING(app.may_write() AND app.actor() IN(sender,recipient)) WITH CHECK(app.actor() IN(sender,recipient));
CREATE POLICY connections_read ON app.connections FOR SELECT USING(app.may_read() AND app.actor() IN(member_a,member_b));
CREATE POLICY blocks_read ON app.blocks FOR SELECT USING(actor=app.actor());
CREATE POLICY mutes_self ON app.mutes FOR ALL USING(actor=app.actor() AND app.may_read()) WITH CHECK(actor=app.actor() AND app.may_read());
CREATE POLICY groups_read ON app.groups FOR SELECT USING(app.may_read() AND app.in_group(id,app.actor()));
CREATE POLICY groups_create ON app.groups FOR INSERT WITH CHECK(owner_id=app.actor() AND app.may_write());
CREATE POLICY groups_update ON app.groups FOR UPDATE USING(app.may_write() AND app.group_manager(id,app.actor()));
CREATE POLICY groups_delete ON app.groups FOR DELETE USING(app.may_write() AND owner_id=app.actor());
CREATE POLICY memberships_read ON app.group_memberships FOR SELECT USING(app.may_read() AND app.in_group(group_id,app.actor()));
CREATE POLICY invitations_read ON app.group_invitations FOR SELECT USING(app.may_read() AND (recipient=app.actor() OR app.group_manager(group_id,app.actor())));
CREATE POLICY invitations_create ON app.group_invitations FOR INSERT WITH CHECK(app.may_write() AND inviter=app.actor() AND app.group_manager(group_id,app.actor()) AND NOT app.blocked(inviter,recipient));
CREATE POLICY posts_read ON app.posts FOR SELECT USING(app.can_post(id));
CREATE POLICY posts_create ON app.posts FOR INSERT WITH CHECK(app.may_write() AND author_id=app.actor() AND (group_id IS NULL OR app.in_group(group_id,app.actor())));
CREATE POLICY posts_update ON app.posts FOR UPDATE USING(app.may_write() AND author_id=app.actor() AND app.can_post(id));
CREATE POLICY posts_delete ON app.posts FOR DELETE USING(app.can_delete_post(id));
CREATE POLICY recipients_read ON app.post_recipients FOR SELECT USING(app.can_post(post_id));
CREATE POLICY recipients_create ON app.post_recipients FOR INSERT WITH CHECK(EXISTS(SELECT FROM app.posts WHERE id=post_id AND author_id=app.actor()) AND app.may_write());
CREATE POLICY comments_read ON app.comments FOR SELECT USING(app.can_comment(id));
CREATE POLICY comments_create ON app.comments FOR INSERT WITH CHECK(author_id=app.actor() AND app.may_write() AND app.can_post(post_id) AND (parent_id IS NULL OR app.can_comment(parent_id)));
CREATE POLICY comments_update ON app.comments FOR UPDATE USING(app.may_write() AND author_id=app.actor() AND app.can_comment(id));
CREATE POLICY comments_delete ON app.comments FOR DELETE USING(app.can_delete_comment(id));
CREATE POLICY post_reactions_read ON app.post_reactions FOR SELECT USING(app.can_post(post_id) AND NOT app.blocked(member_id,app.actor()));
CREATE POLICY post_reactions_write ON app.post_reactions FOR ALL USING(member_id=app.actor() AND app.may_write() AND app.can_post(post_id)) WITH CHECK(member_id=app.actor() AND app.may_write() AND app.can_post(post_id));
CREATE POLICY comment_reactions_read ON app.comment_reactions FOR SELECT USING(app.can_comment(comment_id) AND NOT app.blocked(member_id,app.actor()));
CREATE POLICY comment_reactions_write ON app.comment_reactions FOR ALL USING(member_id=app.actor() AND app.may_write() AND app.can_comment(comment_id)) WITH CHECK(member_id=app.actor() AND app.may_write() AND app.can_comment(comment_id));
CREATE POLICY media_read ON app.media_assets FOR SELECT USING(app.may_read() AND ((post_id IS NULL AND owner_id=app.actor()) OR app.can_post(post_id)));
CREATE POLICY media_create ON app.media_assets FOR INSERT WITH CHECK(owner_id=app.actor() AND app.may_write() AND post_id IS NULL);
CREATE POLICY media_update ON app.media_assets FOR UPDATE USING(owner_id=app.actor() AND app.may_write());
CREATE POLICY media_delete ON app.media_assets FOR DELETE USING(owner_id=app.actor() AND app.may_read());
CREATE POLICY notifications_read ON app.notifications FOR SELECT USING(recipient=app.actor() AND app.may_read() AND (actor IS NULL OR NOT app.blocked(actor,app.actor())) AND (post_id IS NULL OR app.can_post(post_id)) AND (comment_id IS NULL OR app.can_comment(comment_id)) AND (group_id IS NULL OR app.in_group(group_id,app.actor())));
CREATE POLICY notifications_update ON app.notifications FOR UPDATE USING(recipient=app.actor() AND app.may_read());
CREATE POLICY reports_self ON app.reports FOR SELECT USING(reporter=app.actor());
CREATE POLICY reports_create ON app.reports FOR INSERT WITH CHECK(reporter=app.actor());
CREATE POLICY clients_self ON app.integration_clients FOR ALL USING(member_id=app.actor() AND app.may_read()) WITH CHECK(member_id=app.actor() AND app.may_read());
CREATE POLICY grants_self ON app.integration_grants FOR ALL USING(member_id=app.actor() AND app.may_read()) WITH CHECK(member_id=app.actor() AND app.may_read());
CREATE POLICY transfer_self ON app.data_transfer_jobs FOR ALL USING(member_id=app.actor() AND app.may_read()) WITH CHECK(member_id=app.actor() AND app.may_read());
CREATE POLICY epoch_read ON app.directory_epoch FOR SELECT USING(app.may_read());

-- Default privileges on functions must not make privileged helpers executable.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
