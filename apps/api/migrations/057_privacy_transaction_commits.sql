-- Additive reader/restore preparation. Runtime invocation is explicitly opt-in.
-- The terminal marker and fence must commit in the SAME transaction as all
-- protected auth changes. This table alone never authorizes intent retirement.
CREATE TABLE app.privacy_operation_commits (
 operation_id uuid PRIMARY KEY,
 scope_sha256 text NOT NULL CHECK(scope_sha256 ~ '^[a-f0-9]{64}$'),
 generation uuid NOT NULL,
 sequence bigint NOT NULL UNIQUE CHECK(sequence>0)
);
ALTER TABLE app.privacy_operation_commits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.privacy_operation_commits FROM PUBLIC;

CREATE FUNCTION app.complete_privacy_transaction(operation uuid,scope_hash text,expected_generation uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE state app.safety_journal_state; n bigint;
BEGIN
 IF operation IS NULL OR scope_hash IS NULL OR scope_hash !~ '^[a-f0-9]{64}$' OR expected_generation IS NULL
  OR operation::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RAISE EXCEPTION 'INVALID_PRIVACY_COMMIT_SCOPE'; END IF;
 SELECT * INTO state FROM app.safety_journal_state WHERE id FOR UPDATE;
 IF NOT FOUND OR state.restore_quarantined OR current_setting('app.restore_replay',true)='on'
  THEN RAISE EXCEPTION 'RESTORE_QUARANTINED'; END IF;
 IF state.generation<>expected_generation THEN RAISE EXCEPTION 'DATABASE_ROLLBACK_DETECTED'; END IF;
 PERFORM app.append_safety_decision(jsonb_build_object('kind','privacy_operation_committed','operation_id',operation,'scope_sha256',scope_hash));
 SELECT sequence INTO n FROM app.safety_journal_state WHERE id;
 -- A duplicate aborts the caller's transaction. Never return an existing fence
 -- after a second attempt may already have performed different SQL work.
 INSERT INTO app.privacy_operation_commits(operation_id,scope_sha256,generation,sequence)
 VALUES(operation,scope_hash,expected_generation,n);
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.complete_privacy_transaction(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_privacy_transaction(uuid,text,uuid) TO porchday_auth;

-- Preserve every existing restore action. The new marker changes no member
-- state; retain its event and unique fence so a restored ID cannot be reused.
CREATE OR REPLACE FUNCTION app.replay_safety_batch(events jsonb) RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,app,public AS $$
DECLARE event jsonb;d jsonb;n integer:=0;kind text;object uuid;
BEGIN
 IF NOT has_schema_privilege(session_user,'app','CREATE') OR NOT EXISTS(SELECT FROM app.safety_journal_state WHERE id AND restore_quarantined) THEN RAISE EXCEPTION 'RESTORE_QUARANTINE_REQUIRED'; END IF;
 IF jsonb_typeof(events)<>'array' OR jsonb_array_length(events)>500 THEN RAISE EXCEPTION 'INVALID_JOURNAL'; END IF;
 PERFORM set_config('app.restore_replay','on',true);
 FOR event IN SELECT value FROM jsonb_array_elements(events) LOOP
  d:=event->'decision';kind:=d->>'kind';
  IF d->>'kind'='privacy_operation_committed' THEN
   IF jsonb_typeof(d)<>'object' OR d-ARRAY['kind','operation_id','scope_sha256']<>'{}'::jsonb
    OR jsonb_typeof(d->'operation_id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(d->'scope_sha256') IS DISTINCT FROM 'string'
    OR d->>'operation_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR d->>'scope_sha256' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_PRIVACY_COMMIT_MARKER'; END IF;
   INSERT INTO app.privacy_operation_commits(operation_id,scope_sha256,generation,sequence)
   SELECT (d->>'operation_id')::uuid,d->>'scope_sha256',generation,(event->>'sequence')::bigint FROM app.safety_journal_state WHERE id
   ON CONFLICT(operation_id) DO NOTHING;
   IF NOT EXISTS(SELECT FROM app.privacy_operation_commits c JOIN app.safety_journal_state s ON s.id
    WHERE c.operation_id=(d->>'operation_id')::uuid AND c.scope_sha256=d->>'scope_sha256'
    AND c.generation=s.generation AND c.sequence=(event->>'sequence')::bigint)
    THEN RAISE EXCEPTION 'PRIVACY_COMMIT_FENCE_CONFLICT'; END IF;
  ELSE
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
  END IF;
  INSERT INTO app.safety_journal(sequence,id,occurred_at,decision) VALUES((event->>'sequence')::bigint,(event->>'id')::uuid,(event->>'occurred_at')::timestamptz,d) ON CONFLICT(sequence) DO UPDATE SET id=excluded.id,occurred_at=excluded.occurred_at,decision=excluded.decision;
  n:=n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.replay_safety_batch(jsonb) FROM PUBLIC;
