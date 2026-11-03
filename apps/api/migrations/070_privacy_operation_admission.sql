-- A preparation is created before pending registration. Claim and abandonment
-- serialize on the same row. An abort is a committed, empty auth transaction:
-- its existing terminal marker is independent proof only after R2 checkpointing.
CREATE TABLE app.privacy_operation_admissions (
 operation_id uuid PRIMARY KEY,
 scope_sha256 text NOT NULL CHECK(scope_sha256 ~ '^[a-f0-9]{64}$'),
 generation uuid NOT NULL,
 expires_at timestamptz NOT NULL,
 claimed_xid xid8,
 terminal_sequence bigint
);
ALTER TABLE app.privacy_operation_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.privacy_operation_admissions FROM PUBLIC;

CREATE FUNCTION app.prepare_privacy_operation(operation uuid,scope_hash text,expected_generation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE state app.safety_journal_state; existing app.privacy_operation_admissions;
BEGIN
 IF operation IS NULL OR scope_hash IS NULL OR scope_hash !~ '^[a-f0-9]{64}$' OR expected_generation IS NULL
  THEN RAISE EXCEPTION 'INVALID_PRIVACY_COMMIT_SCOPE'; END IF;
 SELECT * INTO state FROM app.safety_journal_state WHERE id;
 IF state.restore_quarantined OR current_setting('app.restore_replay',true)='on' THEN RAISE EXCEPTION 'RESTORE_QUARANTINED'; END IF;
 IF state.generation<>expected_generation THEN RAISE EXCEPTION 'DATABASE_ROLLBACK_DETECTED'; END IF;
 INSERT INTO app.privacy_operation_admissions(operation_id,scope_sha256,generation,expires_at)
 VALUES(operation,scope_hash,expected_generation,clock_timestamp()+interval '3 minutes') ON CONFLICT DO NOTHING;
 SELECT * INTO existing FROM app.privacy_operation_admissions WHERE operation_id=operation;
 IF existing.scope_sha256<>scope_hash OR existing.generation<>expected_generation
  OR existing.terminal_sequence IS NOT NULL OR existing.claimed_xid IS NOT NULL
  OR existing.expires_at<=clock_timestamp() OR EXISTS(SELECT FROM app.privacy_operation_commits WHERE operation_id=operation)
 THEN RAISE EXCEPTION 'PRIVACY_OPERATION_NOT_PREPARED'; END IF;
END $$;

CREATE FUNCTION app.claim_privacy_operation(operation uuid,scope_hash text,expected_generation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE prepared app.privacy_operation_admissions; state app.safety_journal_state;
BEGIN
 SELECT * INTO prepared FROM app.privacy_operation_admissions WHERE operation_id=operation FOR UPDATE;
 IF NOT FOUND OR prepared.scope_sha256 IS DISTINCT FROM scope_hash OR prepared.generation IS DISTINCT FROM expected_generation
  OR prepared.terminal_sequence IS NOT NULL OR prepared.claimed_xid IS NOT NULL
  OR prepared.expires_at<=clock_timestamp() OR EXISTS(SELECT FROM app.privacy_operation_commits WHERE operation_id=operation)
 THEN RAISE EXCEPTION 'PRIVACY_OPERATION_NOT_PREPARED'; END IF;
 SELECT * INTO state FROM app.safety_journal_state WHERE id;
 IF state.restore_quarantined OR current_setting('app.restore_replay',true)='on' THEN RAISE EXCEPTION 'RESTORE_QUARANTINED'; END IF;
 IF state.generation<>expected_generation THEN RAISE EXCEPTION 'DATABASE_ROLLBACK_DETECTED'; END IF;
 UPDATE app.privacy_operation_admissions SET claimed_xid=pg_current_xact_id() WHERE operation_id=operation;
END $$;

CREATE FUNCTION app.finish_privacy_operation(operation uuid,scope_hash text,expected_generation uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE prepared app.privacy_operation_admissions; n bigint;
BEGIN
 SELECT * INTO prepared FROM app.privacy_operation_admissions WHERE operation_id=operation FOR UPDATE;
 IF NOT FOUND OR prepared.scope_sha256 IS DISTINCT FROM scope_hash OR prepared.generation IS DISTINCT FROM expected_generation
  OR prepared.terminal_sequence IS NOT NULL OR prepared.claimed_xid IS DISTINCT FROM pg_current_xact_id()
 THEN RAISE EXCEPTION 'PRIVACY_OPERATION_NOT_CLAIMED'; END IF;
 n:=app.complete_privacy_transaction(operation,scope_hash,expected_generation);
 UPDATE app.privacy_operation_admissions SET terminal_sequence=n WHERE operation_id=operation;
 RETURN n;
END $$;

CREATE FUNCTION app.abandon_privacy_operation(operation uuid,scope_hash text,expected_generation uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE prepared app.privacy_operation_admissions; n bigint;
BEGIN
 -- Never wait behind an active auth transaction or infer its outcome from age.
 SELECT * INTO prepared FROM app.privacy_operation_admissions WHERE operation_id=operation FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF prepared.scope_sha256 IS DISTINCT FROM scope_hash OR prepared.generation IS DISTINCT FROM expected_generation
 THEN RAISE EXCEPTION 'INVALID_PRIVACY_COMMIT_SCOPE'; END IF;
 IF prepared.terminal_sequence IS NOT NULL THEN RETURN prepared.terminal_sequence; END IF;
 -- A claim accidentally committed without its terminal marker is unresolved.
 IF prepared.claimed_xid IS NOT NULL OR prepared.expires_at>clock_timestamp() THEN RETURN NULL; END IF;
 SELECT sequence INTO n FROM app.privacy_operation_commits WHERE operation_id=operation;
 IF FOUND THEN RAISE EXCEPTION 'PRIVACY_COMMIT_FENCE_CONFLICT'; END IF;
 n:=app.complete_privacy_transaction(operation,scope_hash,expected_generation);
 UPDATE app.privacy_operation_admissions SET terminal_sequence=n WHERE operation_id=operation;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.prepare_privacy_operation(uuid,text,uuid),app.claim_privacy_operation(uuid,text,uuid),app.finish_privacy_operation(uuid,text,uuid),app.abandon_privacy_operation(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prepare_privacy_operation(uuid,text,uuid),app.abandon_privacy_operation(uuid,text,uuid) TO porchday_jobs;
GRANT EXECUTE ON FUNCTION app.claim_privacy_operation(uuid,text,uuid),app.finish_privacy_operation(uuid,text,uuid) TO porchday_auth;

-- A caller cannot commit the claim separately and leave a permanent execution
-- gap. Claim and terminal marker are one transaction, including after crashes.
CREATE FUNCTION app.check_privacy_operation_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF EXISTS(SELECT FROM app.privacy_operation_admissions WHERE operation_id=NEW.operation_id
  AND claimed_xid IS NOT NULL AND terminal_sequence IS NULL)
 THEN RAISE EXCEPTION 'PRIVACY_OPERATION_TERMINAL_REQUIRED'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.check_privacy_operation_claim() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER privacy_operation_terminal_required
AFTER INSERT OR UPDATE ON app.privacy_operation_admissions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.check_privacy_operation_claim();

CREATE FUNCTION app.recover_privacy_operation(operation uuid,scope_hash text,expected_generation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE n bigint;
BEGIN
 IF NOT EXISTS(SELECT FROM app.privacy_operation_admissions WHERE operation_id=operation)
 THEN RETURN jsonb_build_object('recognized',false,'sequence',NULL); END IF;
 n:=app.abandon_privacy_operation(operation,scope_hash,expected_generation);
 RETURN jsonb_build_object('recognized',true,'sequence',n::text);
END $$;
REVOKE ALL ON FUNCTION app.recover_privacy_operation(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recover_privacy_operation(uuid,text,uuid) TO porchday_jobs;
