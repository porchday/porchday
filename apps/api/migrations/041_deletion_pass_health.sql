-- An attempt/lease does not prove that R2 accepted a deletion. Keep that
-- acknowledgement separately; do not infer it for existing outbox rows.
ALTER TABLE app.deletion_outbox ADD COLUMN first_deleted_at timestamptz;
COMMENT ON COLUMN app.deletion_outbox.first_deleted_at IS 'First acknowledged R2 deletion; null means no durable successful-delete acknowledgement.';

-- Keep operational_snapshot() unchanged for old Workers during rollout.
-- Version 2 distinguishes the initial removal from the mandatory delayed pass.
CREATE FUNCTION app.operational_snapshot_v2() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 RETURN app.operational_snapshot() || (
  SELECT jsonb_build_object(
   'version',2,
   'deletion_first_pass_pending',count(*) FILTER(WHERE first_deleted_at IS NULL),
   'deletion_first_pass_age_seconds',coalesce(greatest(0,floor(extract(epoch FROM now()-min(created_at) FILTER(WHERE first_deleted_at IS NULL))))::int,0),
   'deletion_final_pass_pending',count(*) FILTER(WHERE first_deleted_at IS NOT NULL),
   'deletion_final_pass_overdue_seconds',coalesce(greatest(0,floor(extract(epoch FROM now()-(min(created_at) FILTER(WHERE first_deleted_at IS NOT NULL)+interval '10 minutes'))))::int,0)
  ) FROM app.deletion_outbox WHERE completed_at IS NULL
 );
END $$;
REVOKE ALL ON FUNCTION app.operational_snapshot_v2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operational_snapshot_v2() TO porchday_jobs;
