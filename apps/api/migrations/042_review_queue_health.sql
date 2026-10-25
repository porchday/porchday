-- Aggregates only. The monitoring Worker never receives a database credential,
-- report identity, account reference, safe email, or disclosed evidence.
CREATE INDEX reports_review_backlog ON app.reports(created_at)
 WHERE status IN('received','reviewing','appealed');
CREATE INDEX recovery_review_backlog ON public.recovery_cases(contact_verified_at)
 WHERE contact_verified_at IS NOT NULL AND state IN('submitted','reviewing','hold');

-- Preserve v1/v2 for rolling deployment and rollback. Ages start at original
-- report creation / verified contact, not last update or reviewer assignment.
CREATE FUNCTION app.operational_snapshot_v3() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.operational_snapshot_v2() || jsonb_build_object('version',3) ||
 (SELECT jsonb_build_object(
  'moderation_pending',count(*),
  'moderation_age_seconds',coalesce(greatest(0,floor(extract(epoch FROM now()-min(created_at))))::bigint,0)
 ) FROM app.reports WHERE status IN('received','reviewing','appealed') AND retention_until>now()) ||
 (SELECT jsonb_build_object(
  'recovery_pending',count(*),
  'recovery_age_seconds',coalesce(greatest(0,floor(extract(epoch FROM now()-min(greatest(created_at,contact_verified_at)))))::bigint,0)
 ) FROM public.recovery_cases
 WHERE contact_verified_at IS NOT NULL AND state IN('submitted','reviewing','hold') AND retention_until>now())
$$;
REVOKE ALL ON FUNCTION app.operational_snapshot_v3() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operational_snapshot_v3() TO porchday_jobs;
