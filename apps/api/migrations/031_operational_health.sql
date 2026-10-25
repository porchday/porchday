-- Aggregate operations signals contain no member identifiers or private content.
CREATE TABLE app.operations_heartbeat (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 cleanup_succeeded_at timestamptz
);
INSERT INTO app.operations_heartbeat(id) VALUES(true);
REVOKE ALL ON app.operations_heartbeat FROM PUBLIC;
CREATE FUNCTION app.record_cleanup_success() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 UPDATE app.operations_heartbeat SET cleanup_succeeded_at=now() WHERE id
$$;
CREATE FUNCTION app.operational_snapshot() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT jsonb_build_object(
  'cleanup_age_seconds',(SELECT greatest(0,extract(epoch FROM now()-cleanup_succeeded_at))::int FROM app.operations_heartbeat WHERE id),
  'deletion_pending',(SELECT count(*) FROM app.deletion_outbox WHERE completed_at IS NULL),
  'deletion_age_seconds',(SELECT coalesce(greatest(0,extract(epoch FROM now()-min(created_at)))::int,0) FROM app.deletion_outbox WHERE completed_at IS NULL),
  'identity_pending',(SELECT count(*) FROM app.identity_deletion_outbox WHERE completed_at IS NULL),
  'identity_age_seconds',(SELECT coalesce(greatest(0,extract(epoch FROM now()-min(created_at)))::int,0) FROM app.identity_deletion_outbox WHERE completed_at IS NULL),
  'email_pending',(SELECT count(*) FROM public.auth_email_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND expires_at>now()),
  'email_failed',(SELECT count(*) FROM public.auth_email_outbox WHERE failed_at IS NOT NULL),
  'email_age_seconds',(SELECT coalesce(greatest(0,extract(epoch FROM now()-min(created_at)))::int,0) FROM public.auth_email_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND expires_at>now()),
  'web_push_pending',(SELECT count(*) FROM app.push_outbox WHERE completed_at IS NULL),
  'native_push_pending',(SELECT count(*) FROM app.native_push_outbox WHERE completed_at IS NULL)
 )
$$;
REVOKE ALL ON FUNCTION app.record_cleanup_success(),app.operational_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_cleanup_success(),app.operational_snapshot() TO porchday_jobs;
