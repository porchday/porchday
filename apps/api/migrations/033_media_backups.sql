-- Frozen metadata inventory only; ciphertext remains in separate private R2.
CREATE TABLE app.media_backup_runs(
 id uuid PRIMARY KEY,day date NOT NULL UNIQUE,restore_at timestamptz NOT NULL,
 generation uuid NOT NULL,base_sequence bigint NOT NULL,
 expires_at timestamptz NOT NULL,completed_at timestamptz,failure_count integer NOT NULL DEFAULT 0,last_failure_at timestamptz,
 CHECK(expires_at=restore_at+interval '7 days')
);
CREATE TABLE app.media_backup_items(
 run_id uuid NOT NULL REFERENCES app.media_backup_runs ON DELETE CASCADE,
 object_key text NOT NULL CHECK(object_key ~ '^media/[a-f0-9-]{36}/[a-f0-9-]{36}$'),
 canonical_sha256 text NOT NULL CHECK(canonical_sha256 ~ '^[a-f0-9]{64}$'),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 22020096),
 PRIMARY KEY(run_id,object_key)
);
ALTER TABLE app.media_backup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.media_backup_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.media_backup_runs,app.media_backup_items FROM PUBLIC;
CREATE FUNCTION app.media_backup_start(run uuid,paired_at timestamptz) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE result app.media_backup_runs;
BEGIN
 IF paired_at>clock_timestamp() OR paired_at<clock_timestamp()-interval '1 minute' THEN RAISE EXCEPTION 'BACKUP_CLOCK_INVALID';END IF;
 IF EXISTS(SELECT FROM app.safety_journal_state WHERE restore_quarantined) THEN RAISE EXCEPTION 'RESTORE_QUARANTINED';END IF;
 DELETE FROM app.media_backup_runs WHERE expires_at<=now();
 INSERT INTO app.media_backup_runs(id,day,restore_at,generation,base_sequence,expires_at)
 SELECT run,(paired_at AT TIME ZONE 'UTC')::date,paired_at,generation,sequence,paired_at+interval '7 days' FROM app.safety_journal_state WHERE id
 ON CONFLICT(day) DO NOTHING RETURNING * INTO result;
 IF result.id IS NOT NULL THEN
  INSERT INTO app.media_backup_items(run_id,object_key,canonical_sha256,byte_size)
  SELECT result.id,m.object_key,m.envelope_sha256,m.byte_size FROM app.media_assets m
  WHERE m.state IN('ready','attached') AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>paired_at);
 ELSE SELECT * INTO result FROM app.media_backup_runs WHERE day=(paired_at AT TIME ZONE 'UTC')::date;END IF;
 RETURN to_jsonb(result)||jsonb_build_object('base_sequence',result.base_sequence::text);
END $$;
CREATE FUNCTION app.media_backup_info(run uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT to_jsonb(r)||jsonb_build_object('base_sequence',r.base_sequence::text) FROM app.media_backup_runs r WHERE id=run AND expires_at>now()
$$;
CREATE FUNCTION app.media_backup_page(run uuid,after_key text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.object_key),'[]') FROM(
  SELECT object_key,canonical_sha256,byte_size FROM app.media_backup_items WHERE run_id=run AND object_key>coalesce(after_key,'')
  AND EXISTS(SELECT FROM app.media_backup_runs WHERE id=run AND expires_at>now()) ORDER BY object_key LIMIT 8
 ) i
$$;
CREATE FUNCTION app.media_backup_missing(run uuid,key text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT s.sequence::text FROM app.safety_journal_state s WHERE s.id AND NOT s.restore_quarantined
 AND EXISTS(SELECT FROM app.media_backup_items WHERE run_id=run AND object_key=key)
 AND EXISTS(SELECT FROM app.deletion_outbox WHERE object_key=key)
$$;
CREATE FUNCTION app.media_backup_complete(run uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 UPDATE app.media_backup_runs SET completed_at=coalesce(completed_at,now()) WHERE id=run AND expires_at>now()
$$;
REVOKE ALL ON FUNCTION app.media_backup_start(uuid,timestamptz),app.media_backup_info(uuid),app.media_backup_page(uuid,text),app.media_backup_missing(uuid,text),app.media_backup_complete(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_backup_start(uuid,timestamptz),app.media_backup_info(uuid),app.media_backup_page(uuid,text),app.media_backup_missing(uuid,text),app.media_backup_complete(uuid) TO porchday_jobs;

CREATE FUNCTION app.media_backup_failed(run uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 UPDATE app.media_backup_runs SET failure_count=failure_count+1,last_failure_at=now() WHERE id=run AND completed_at IS NULL AND expires_at>now()
$$;
CREATE FUNCTION app.media_backup_health() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT jsonb_build_object('last_complete_age_seconds',floor(extract(epoch FROM now()-max(restore_at) FILTER(WHERE completed_at IS NOT NULL)))::integer,
 'unfinished_runs',count(*) FILTER(WHERE completed_at IS NULL),
 'oldest_unfinished_age_seconds',coalesce(floor(extract(epoch FROM now()-min(restore_at) FILTER(WHERE completed_at IS NULL)))::integer,0),
 'failed_runs',count(*) FILTER(WHERE completed_at IS NULL AND failure_count>0))
 FROM app.media_backup_runs WHERE expires_at>now()
$$;
REVOKE ALL ON FUNCTION app.media_backup_failed(uuid),app.media_backup_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.media_backup_failed(uuid),app.media_backup_health() TO porchday_jobs;
