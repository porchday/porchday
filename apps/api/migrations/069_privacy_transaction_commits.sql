-- Additive reader/restore preparation. Runtime invocation is explicitly opt-in.
-- The terminal marker and fence must commit in the SAME transaction as all
-- protected auth changes. This table alone never authorizes intent retirement.
CREATE TABLE IF NOT EXISTS app.privacy_operation_commits (
 operation_id uuid PRIMARY KEY,
 scope_sha256 text NOT NULL CHECK(scope_sha256 ~ '^[a-f0-9]{64}$'),
 generation uuid NOT NULL,
 sequence bigint NOT NULL UNIQUE CHECK(sequence>0)
);
ALTER TABLE app.privacy_operation_commits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.privacy_operation_commits FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.complete_privacy_transaction(operation uuid,scope_hash text,expected_generation uuid) RETURNS bigint
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

-- Install after current photo/child restore extensions. Never replace those
-- handlers with the older migration-057 definition. Existing staging databases
-- may already have that marker reader; their extended definition is retained.
DO $migration$
DECLARE definition text; original text; needle text := $needle$  CASE d->>'action'$needle$;
 tail text := $tail$  END CASE;$tail$;
BEGIN
 SELECT pg_get_functiondef('app.replay_safety_batch(jsonb)'::regprocedure) INTO definition;
 original := definition;
 IF position('privacy_operation_committed' in definition)=0 THEN
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1
   OR (length(definition)-length(replace(definition,tail,'')))/length(tail)<>1
   THEN RAISE EXCEPTION 'UNRECOGNIZED_RESTORE_READER'; END IF;
  definition := replace(definition,needle,$marker$  IF d->>'kind'='privacy_operation_committed' THEN
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
$marker$ || needle);
  definition := replace(definition,tail,tail || E'\n  END IF;');
  EXECUTE definition;
 END IF;
END $migration$;
REVOKE ALL ON FUNCTION app.replay_safety_batch(jsonb) FROM PUBLIC;
