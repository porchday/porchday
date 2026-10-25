-- Daily runs keep their UNIQUE day slot. Owner-requested runs use NULL and
-- retain independent immutable inventories rather than replacing that slot.
ALTER TABLE app.media_backup_runs ALTER COLUMN day DROP NOT NULL;

CREATE FUNCTION app.media_backup_start_manual(run uuid,paired_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
DECLARE result app.media_backup_runs;
BEGIN
 IF NOT has_schema_privilege(session_user,'app','CREATE') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF EXISTS(SELECT FROM app.safety_journal_state WHERE restore_quarantined) THEN RAISE EXCEPTION 'RESTORE_QUARANTINED'; END IF;
 SELECT * INTO result FROM app.media_backup_runs WHERE id=run;
 IF FOUND THEN
  IF result.day IS NOT NULL OR result.restore_at<>paired_at OR result.expires_at<=now() THEN RAISE EXCEPTION 'BACKUP_ID_CONFLICT'; END IF;
  RETURN to_jsonb(result)||jsonb_build_object('base_sequence',result.base_sequence::text);
 END IF;
 IF paired_at>clock_timestamp() OR paired_at<clock_timestamp()-interval '1 minute' THEN RAISE EXCEPTION 'BACKUP_CLOCK_INVALID';END IF;
 INSERT INTO app.media_backup_runs(id,day,restore_at,generation,base_sequence,expires_at)
 SELECT run,NULL,paired_at,generation,sequence,paired_at+interval '7 days'
 FROM app.safety_journal_state WHERE id
 ON CONFLICT(id) DO NOTHING RETURNING * INTO result;
 IF result.id IS NULL THEN
  SELECT * INTO result FROM app.media_backup_runs WHERE id=run;
  IF result.day IS NOT NULL OR result.restore_at<>paired_at OR result.expires_at<=now() THEN RAISE EXCEPTION 'BACKUP_ID_CONFLICT'; END IF;
 ELSE
  INSERT INTO app.media_backup_items(run_id,object_key,canonical_sha256,sha256,byte_size)
  SELECT result.id,m.object_key,m.envelope_sha256,m.raw_sha256,m.byte_size
  FROM app.media_assets m
  WHERE m.state IN('ready','attached') AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>paired_at);
 END IF;
 RETURN to_jsonb(result)||jsonb_build_object('base_sequence',result.base_sequence::text);
END $$;
REVOKE ALL ON FUNCTION app.media_backup_start_manual(uuid,timestamptz) FROM PUBLIC,porchday_auth,porchday_social,porchday_jobs;
