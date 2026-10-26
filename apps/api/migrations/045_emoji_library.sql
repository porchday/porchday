-- Explicit consent for the new private collection; existing grants gain no scope.
ALTER TABLE app.integration_grants DROP CONSTRAINT integration_grants_scopes_check;
ALTER TABLE app.integration_grants ADD CONSTRAINT integration_grants_scopes_check CHECK(scopes<@ARRAY['profile:read','content:read','media:read','export:read','emoji:read']::text[]);

-- Saved emoji collections are independent of shared profiles. Their profile-kind
-- envelopes are always owner-only; labels, images and hashes remain encrypted.
CREATE TABLE app.emoji_libraries (
 member_id uuid PRIMARY KEY REFERENCES app.members(id) ON DELETE CASCADE,
 envelope jsonb,
 revision integer NOT NULL CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(envelope IS NULL OR octet_length(envelope::text)<=3200000)
);
ALTER TABLE app.emoji_libraries ENABLE ROW LEVEL SECURITY;
CREATE POLICY emoji_library_read ON app.emoji_libraries FOR SELECT USING(member_id=app.actor() AND app.may_manage_data());
CREATE POLICY emoji_library_insert ON app.emoji_libraries FOR INSERT WITH CHECK(member_id=app.actor() AND app.may_write());
CREATE POLICY emoji_library_update ON app.emoji_libraries FOR UPDATE USING(member_id=app.actor() AND app.may_write()) WITH CHECK(member_id=app.actor() AND app.may_write());
REVOKE ALL ON app.emoji_libraries FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON app.emoji_libraries TO porchday_social;

CREATE FUNCTION app.check_emoji_library() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
DECLARE c jsonb:=NEW.envelope->'context';BEGIN
 IF current_setting('app.restore_replay',true)='on' AND has_schema_privilege(session_user,'app','CREATE') THEN RETURN NEW;END IF;
 IF NEW.envelope IS NULL OR c->>'kind' IS DISTINCT FROM 'profile' OR c->>'id' IS DISTINCT FROM NEW.member_id::text
  OR c->>'authorId' IS DISTINCT FROM NEW.member_id::text OR c->>'audience' IS DISTINCT FROM 'only_me'
  OR c->>'parentId' IS NOT NULL OR c->>'groupId' IS NOT NULL OR c->>'expiresAt' IS NOT NULL
  OR jsonb_typeof(NEW.envelope->'recipients') IS DISTINCT FROM 'array'
  OR jsonb_array_length(NEW.envelope->'recipients')=0
  OR EXISTS(SELECT FROM jsonb_array_elements(NEW.envelope->'recipients') r WHERE r->>'memberId' IS DISTINCT FROM NEW.member_id::text)
  THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF (c->>'revision')::integer IS DISTINCT FROM NEW.revision OR NEW.revision IS DISTINCT FROM (CASE WHEN TG_OP='INSERT' THEN 1 ELSE OLD.revision+1 END) THEN RAISE EXCEPTION 'REVISION_CHANGED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER check_emoji_library BEFORE INSERT OR UPDATE ON app.emoji_libraries FOR EACH ROW EXECUTE FUNCTION app.check_emoji_library();

CREATE FUNCTION app.journal_emoji_library() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 -- An older restored collection must not bring deleted custom images back.
 PERFORM app.append_safety_decision(jsonb_build_object('action','revision','kind','emoji_libraries','id',NEW.member_id,'revision',NEW.revision));
 UPDATE app.data_transfer_jobs SET state='invalidated' WHERE member_id=NEW.member_id AND kind='export' AND state IN('pending','complete');
 RETURN NEW;
END $$;
CREATE TRIGGER journal_emoji_library AFTER UPDATE ON app.emoji_libraries FOR EACH ROW EXECUTE FUNCTION app.journal_emoji_library();
REVOKE ALL ON FUNCTION app.check_emoji_library(),app.journal_emoji_library() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.export_window(section text,snapshot_at timestamptz,after_id text,take_count integer,exact_id text) RETURNS TABLE(export_id text,item jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT owned.export_id,owned.item FROM (
 SELECT p.member_id::text,to_jsonb(p) FROM app.profiles p WHERE section='profile' AND p.member_id=app.actor()
 UNION ALL SELECT e.member_id::text,to_jsonb(e) FROM app.emoji_libraries e WHERE section='emoji_library' AND e.member_id=app.actor() AND e.envelope IS NOT NULL
 UNION ALL SELECT p.id::text,to_jsonb(p) FROM app.posts p WHERE section='posts' AND p.author_id=app.actor() AND p.stored_at<=snapshot_at AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())
 UNION ALL SELECT c.id::text,to_jsonb(c)||jsonb_build_object('effective_expires_at',app.comment_deadline(c.id)) FROM app.comments c WHERE section='comments' AND c.author_id=app.actor() AND c.stored_at<=snapshot_at AND(app.comment_deadline(c.id) IS NULL OR app.comment_deadline(c.id)>statement_timestamp())
 UNION ALL SELECT r.post_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.post_reactions r JOIN app.posts p ON p.id=r.post_id WHERE section='post_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT r.comment_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.comment_reactions r WHERE section='comment_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT m.id::text,(to_jsonb(m)-'object_key')||jsonb_build_object('effective_expires_at',app.media_deadline(m.id)) FROM app.media_assets m WHERE section='media' AND m.owner_id=app.actor() AND m.state IN('ready','attached') AND m.created_at<=snapshot_at AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp())
 UNION ALL SELECT (CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END)::text,jsonb_build_object('member_id',CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END,'kind',c.kind) FROM app.connections c WHERE section='connections' AND app.actor() IN(c.member_a,c.member_b) AND c.accepted_at<=snapshot_at
 UNION ALL SELECT g.group_id::text,jsonb_build_object('group_id',g.group_id,'role',g.role) FROM app.group_memberships g WHERE section='groups' AND g.member_id=app.actor() AND g.joined_at<=snapshot_at
 ) owned(export_id,item) WHERE CASE WHEN exact_id IS NULL THEN owned.export_id>after_id ELSE owned.export_id=exact_id END
 ORDER BY owned.export_id LIMIT least(greatest(take_count,1),26)
$$;
REVOKE ALL ON FUNCTION app.export_window(text,timestamptz,text,integer,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.export_page(job uuid,section text,after_id text DEFAULT '') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.data_transfer_jobs;rows jsonb;next_id text;BEGIN
 IF NOT app.may_manage_data() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT * INTO j FROM app.data_transfer_jobs WHERE id=job AND member_id=app.actor() AND kind='export' AND state='complete' AND expires_at>statement_timestamp();
 IF j.id IS NULL THEN RAISE EXCEPTION 'EXPORT_INVALIDATED';END IF;
 IF section NOT IN('profile','emoji_library','posts','comments','post_reactions','comment_reactions','media','connections','groups') OR length(after_id)>256 THEN RAISE EXCEPTION 'INVALID_EXPORT_SECTION';END IF;
 WITH page AS(SELECT export_id,item||jsonb_build_object('export_id',export_id) AS item FROM app.export_window(section,j.created_at,after_id,26,NULL)),numbered AS(SELECT *,row_number() OVER(ORDER BY export_id) AS n,sum(octet_length(item::text)) OVER(ORDER BY export_id) AS byte_count FROM page)
 SELECT coalesce(jsonb_agg(item ORDER BY export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)),'[]'::jsonb),CASE WHEN count(*)>count(*) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) THEN max(export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) END INTO rows,next_id FROM numbered;
 RETURN jsonb_build_object('schema_version',1,'generated_at',j.created_at,'next_cursor',next_id,section,CASE WHEN section IN('profile','emoji_library') THEN rows->0 ELSE rows END);
END $$;

CREATE OR REPLACE FUNCTION app.validate_export(job uuid,refs jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.data_transfer_jobs;ref jsonb;row jsonb;section text;deadline timestamptz;BEGIN
 IF NOT app.may_manage_data() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT * INTO j FROM app.data_transfer_jobs WHERE id=job AND member_id=app.actor() AND kind='export' AND state='complete' AND expires_at>statement_timestamp();
 IF j.id IS NULL THEN RAISE EXCEPTION 'EXPORT_INVALIDATED';END IF;
 IF jsonb_typeof(refs)<>'array' OR jsonb_array_length(refs)>1000 THEN RAISE EXCEPTION 'INVALID_EXPORT_REFS';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
  section:=CASE ref->>'kind' WHEN 'profile' THEN 'profile' WHEN 'emoji_library' THEN 'emoji_library' WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'comments' WHEN 'post_reaction' THEN 'post_reactions' WHEN 'comment_reaction' THEN 'comment_reactions' WHEN 'media' THEN 'media' END;
  IF section IS NULL THEN RETURN false;END IF;
  SELECT item INTO row FROM app.export_window(section,j.created_at,'',1,ref->>'id');
  IF row IS NULL OR(row->'envelope'->'context'->>'revision')::integer IS DISTINCT FROM(ref->>'revision')::integer THEN RETURN false;END IF;
  deadline:=least((row->>'effective_expires_at')::timestamptz,(row->>'expires_at')::timestamptz,(row->'envelope'->'context'->>'expiresAt')::timestamptz);
  IF deadline IS DISTINCT FROM(ref->>'expires_at')::timestamptz OR deadline<=statement_timestamp() THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
CREATE OR REPLACE FUNCTION app.integration_page(token_hash text,requested_scope text,section text,after_id text DEFAULT '',snapshot_at timestamptz DEFAULT statement_timestamp()) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE g app.integration_grants;rows jsonb;next_id text;BEGIN
 SELECT ig.* INTO g FROM app.integration_grants ig JOIN app.members m ON m.id=ig.member_id WHERE ig.access_hash=token_hash AND requested_scope=ANY(ig.scopes) AND ig.access_expires_at>now() AND ig.expires_at>now() AND ig.revoked_at IS NULL AND m.status IN('active','restricted');
 IF g.id IS NULL THEN RAISE EXCEPTION 'INVALID_GRANT';END IF;
 IF length(after_id)>256 OR snapshot_at>statement_timestamp()+interval '1 second' OR NOT((requested_scope='profile:read' AND section='profile') OR(requested_scope='emoji:read' AND section='emoji_library') OR(requested_scope='content:read' AND section IN('posts','comments','post_reactions','comment_reactions')) OR(requested_scope='media:read' AND section='media') OR(requested_scope='export:read' AND section='jobs')) THEN RAISE EXCEPTION 'INVALID_GRANT';END IF;
 PERFORM set_config('app.member_id',g.member_id::text,true);
 IF section='jobs' THEN
  WITH page AS(SELECT id::text export_id,to_jsonb(j) item FROM app.data_transfer_jobs j WHERE member_id=g.member_id AND kind='export' AND created_at<=snapshot_at AND id::text>after_id ORDER BY id::text LIMIT 26),numbered AS(SELECT *,row_number() OVER(ORDER BY export_id) n,sum(octet_length(item::text)) OVER(ORDER BY export_id) byte_count FROM page)
  SELECT coalesce(jsonb_agg(item ORDER BY export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)),'[]'::jsonb),CASE WHEN count(*)>count(*) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) THEN max(export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) END INTO rows,next_id FROM numbered;
 ELSE
  WITH page AS(SELECT export_id,item FROM app.export_window(section,snapshot_at,after_id,26,NULL)),numbered AS(SELECT *,row_number() OVER(ORDER BY export_id) n,sum(octet_length(item::text)) OVER(ORDER BY export_id) byte_count FROM page)
  SELECT coalesce(jsonb_agg(item ORDER BY export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)),'[]'::jsonb),CASE WHEN count(*)>count(*) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) THEN max(export_id) FILTER(WHERE n<=25 AND(byte_count<=4194304 OR n=1)) END INTO rows,next_id FROM numbered;
 END IF;
 UPDATE app.integration_grants SET last_used_at=now() WHERE id=g.id;
 RETURN jsonb_build_object(section,CASE WHEN section IN('profile','emoji_library') THEN rows->0 ELSE rows END,'next_id',next_id,'snapshot_at',snapshot_at);
END $$;

-- Replay drops superseded ciphertext while preserving the revision floor.
CREATE OR REPLACE FUNCTION app.replay_safety_batch(events jsonb) RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,app,public AS $$
DECLARE event jsonb;d jsonb;n integer:=0;kind text;object uuid;
BEGIN
 IF NOT has_schema_privilege(session_user,'app','CREATE') OR NOT EXISTS(SELECT FROM app.safety_journal_state WHERE id AND restore_quarantined) THEN RAISE EXCEPTION 'RESTORE_QUARANTINE_REQUIRED'; END IF;
 IF jsonb_typeof(events)<>'array' OR jsonb_array_length(events)>500 THEN RAISE EXCEPTION 'INVALID_JOURNAL'; END IF;
 PERFORM set_config('app.restore_replay','on',true);
 FOR event IN SELECT value FROM jsonb_array_elements(events) LOOP
  d:=event->'decision';kind:=d->>'kind';
  CASE d->>'action'
  WHEN 'delete' THEN
   object:=(d->>'id')::uuid;
   IF kind='members' THEN
    -- A replayed member deletion must not leave a restored owned group behind.
    DELETE FROM app.groups WHERE owner_id=object;DELETE FROM app.members WHERE id=object;
    DELETE FROM public.auth_user WHERE id=object::text;
   ELSIF kind IN('posts','comments','groups','media_assets') THEN EXECUTE format('DELETE FROM app.%I WHERE id=$1',kind) USING object;
   ELSE RAISE EXCEPTION 'INVALID_JOURNAL_KIND'; END IF;
   INSERT INTO app.deletion_ledger(kind,object_id) VALUES(kind,object) ON CONFLICT DO NOTHING;
  WHEN 'deadline' THEN
   IF kind NOT IN('posts','comments') THEN RAISE EXCEPTION 'INVALID_JOURNAL_KIND'; END IF;
   EXECUTE format('UPDATE app.%I SET expires_at=least(expires_at,$1) WHERE id=$2 AND(expires_at IS NULL OR expires_at>$1)',kind) USING(d->>'expires_at')::timestamptz,(d->>'id')::uuid;
  WHEN 'revision' THEN
   IF(d->>'revision')::integer<1 THEN RAISE EXCEPTION 'INVALID_JOURNAL_REVISION'; END IF;
   IF kind IN('posts','comments') THEN
    EXECUTE format('DELETE FROM app.%I WHERE id=$1 AND coalesce((envelope->''context''->>''revision'')::integer,0)<$2',kind) USING(d->>'id')::uuid,(d->>'revision')::integer;
   ELSIF kind='emoji_libraries' THEN
    INSERT INTO app.emoji_libraries(member_id,envelope,revision) SELECT (d->>'id')::uuid,NULL,(d->>'revision')::integer WHERE EXISTS(SELECT FROM app.members WHERE id=(d->>'id')::uuid)
    ON CONFLICT(member_id) DO UPDATE SET envelope=NULL,revision=excluded.revision WHERE emoji_libraries.revision<excluded.revision;
   ELSIF kind='profiles' THEN UPDATE app.profiles SET envelope=NULL WHERE member_id=(d->>'id')::uuid AND coalesce((envelope->'context'->>'revision')::integer,0)<(d->>'revision')::integer;
   ELSIF kind='groups' THEN UPDATE app.groups SET envelope='{}' WHERE id=(d->>'id')::uuid AND coalesce((envelope->'context'->>'revision')::integer,0)<(d->>'revision')::integer;
   ELSE RAISE EXCEPTION 'INVALID_JOURNAL_KIND'; END IF;
  WHEN 'media_object' THEN
   IF d->>'key' !~ '^media/' OR length(d->>'key')>1024 THEN RAISE EXCEPTION 'INVALID_JOURNAL_KEY'; END IF;
   INSERT INTO app.deletion_outbox(object_key,reason) VALUES(d->>'key','restore_reconciliation') ON CONFLICT(object_key) DO UPDATE SET completed_at=NULL,next_retry=now();
  WHEN 'reaction' THEN
   IF kind NOT IN('post_reactions','comment_reactions') THEN RAISE EXCEPTION 'INVALID_JOURNAL_KIND'; END IF;
   EXECUTE format('DELETE FROM app.%I WHERE %I=$1 AND member_id=$2 AND reaction_tag=$3',kind,CASE WHEN kind='post_reactions' THEN 'post_id' ELSE 'comment_id' END) USING(d->>'target')::uuid,(d->>'member')::uuid,d->>'tag';
  WHEN 'connection' THEN DELETE FROM app.connections WHERE member_a=(d->>'a')::uuid AND member_b=(d->>'b')::uuid;
  WHEN 'membership' THEN DELETE FROM app.group_memberships WHERE group_id=(d->>'group')::uuid AND member_id=(d->>'member')::uuid;
  WHEN 'group_owner' THEN
   IF EXISTS(SELECT FROM app.groups WHERE id=(d->>'id')::uuid) AND NOT EXISTS(SELECT FROM app.members WHERE id=(d->>'owner')::uuid) THEN RAISE EXCEPTION 'RESTORE_OWNER_MISSING'; END IF;
   UPDATE app.groups SET owner_id=(d->>'owner')::uuid WHERE id=(d->>'id')::uuid;
  WHEN 'group_role' THEN UPDATE app.group_memberships SET role=d->>'role' WHERE group_id=(d->>'group')::uuid AND member_id=(d->>'member')::uuid;
  WHEN 'recipient' THEN DELETE FROM app.post_recipients WHERE post_id=(d->>'post')::uuid AND device_id=(d->>'device')::uuid;
  WHEN 'block' THEN
   IF EXISTS(SELECT FROM app.members WHERE id=(d->>'actor')::uuid) AND EXISTS(SELECT FROM app.members WHERE id=(d->>'target')::uuid) THEN INSERT INTO app.blocks(actor,target) VALUES((d->>'actor')::uuid,(d->>'target')::uuid) ON CONFLICT DO NOTHING; END IF;
  WHEN 'device' THEN UPDATE app.device_keys SET revoked_at=coalesce(revoked_at,now()) WHERE id=(d->>'id')::uuid;
  WHEN 'status' THEN UPDATE app.members SET status=d->>'status' WHERE id=(d->>'id')::uuid;
  WHEN 'security_hold' THEN PERFORM app.set_security_hold((d->>'id')::uuid);
  WHEN 'identity' THEN DELETE FROM public.auth_user WHERE id=d->>'id';
  WHEN 'key_backup' THEN DELETE FROM app.encrypted_key_backups WHERE member_id=(d->>'id')::uuid;
  ELSE RAISE EXCEPTION 'INVALID_JOURNAL_ACTION';
  END CASE;
  INSERT INTO app.safety_journal(sequence,id,occurred_at,decision) VALUES((event->>'sequence')::bigint,(event->>'id')::uuid,(event->>'occurred_at')::timestamptz,d) ON CONFLICT(sequence) DO UPDATE SET id=excluded.id,occurred_at=excluded.occurred_at,decision=excluded.decision;
  n:=n+1;
 END LOOP;
 RETURN n;
END $$;

-- Unicode/custom identities expand the finite six-reaction catalog. Bound each
-- member and the complete thread's encrypted reaction data before inserting.
-- Duplicate PUTs remain idempotent even when a limit is reached.
CREATE FUNCTION app.limit_reaction_storage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE target uuid;parent uuid;used bigint;own_count integer;duplicate boolean;
BEGIN
 IF TG_TABLE_NAME='post_reactions' THEN target:=NEW.post_id;parent:=target;
 ELSE target:=NEW.comment_id;SELECT post_id INTO parent FROM app.comments WHERE id=target;END IF;
 PERFORM 1 FROM app.posts WHERE id=parent FOR UPDATE;
 IF TG_TABLE_NAME='post_reactions' THEN
  SELECT count(*),coalesce(bool_or(reaction_tag=NEW.reaction_tag),false) INTO own_count,duplicate FROM app.post_reactions WHERE post_id=target AND member_id=NEW.member_id;
 ELSE
  SELECT count(*),coalesce(bool_or(reaction_tag=NEW.reaction_tag),false) INTO own_count,duplicate FROM app.comment_reactions WHERE comment_id=target AND member_id=NEW.member_id;
 END IF;
 IF duplicate THEN RETURN NEW;END IF;
 IF own_count>=20 THEN RAISE EXCEPTION 'REACTION_LIMIT';END IF;
 SELECT coalesce(sum(bytes),0) INTO used FROM (
  SELECT octet_length(envelope::text) bytes FROM app.post_reactions WHERE post_id=parent
  UNION ALL SELECT octet_length(r.envelope::text) FROM app.comment_reactions r JOIN app.comments c ON c.id=r.comment_id WHERE c.post_id=parent
 ) all_reactions;
 IF used+octet_length(NEW.envelope::text)>16777216 THEN RAISE EXCEPTION 'REACTION_STORAGE_LIMIT';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER post_reaction_storage BEFORE INSERT ON app.post_reactions FOR EACH ROW EXECUTE FUNCTION app.limit_reaction_storage();
CREATE TRIGGER comment_reaction_storage BEFORE INSERT ON app.comment_reactions FOR EACH ROW EXECUTE FUNCTION app.limit_reaction_storage();
REVOKE ALL ON FUNCTION app.limit_reaction_storage() FROM PUBLIC;

-- Reactions are immutable: remove and add instead of replacing ciphertext.
REVOKE UPDATE ON app.post_reactions,app.comment_reactions FROM porchday_social;
