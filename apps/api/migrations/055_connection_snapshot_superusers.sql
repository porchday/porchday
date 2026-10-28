-- Correct aggregate attribution without changing the function contract or grants.
-- pg_has_role returns true for superusers for every role.
CREATE OR REPLACE FUNCTION app.connection_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object(
  'max_connections',current_setting('max_connections')::int,
  'reserved_connections',current_setting('superuser_reserved_connections')::int,
  'groups',coalesce((SELECT jsonb_agg(g) FROM (
   -- Hosted logins are provider usernames that inherit one runtime role.
   -- Superusers satisfy pg_has_role for every role without membership;
   -- classify them first so provider backends do not inflate auth counts.
   SELECT CASE WHEN usesysid IS NULL OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=usesysid AND r.rolsuper) THEN 'other'
     WHEN pg_has_role(usesysid,'porchday_auth','USAGE') THEN 'auth'
     WHEN pg_has_role(usesysid,'porchday_social','USAGE') THEN 'social'
     WHEN pg_has_role(usesysid,'porchday_jobs','USAGE') THEN 'jobs'
     ELSE 'other' END AS role,
    coalesce(state,'unknown') AS state,
    count(*)::int AS connections,
    coalesce(floor(max(extract(epoch FROM now()-xact_start))*1000),0)::bigint AS oldest_transaction_ms
   FROM pg_stat_activity WHERE backend_type='client backend' GROUP BY 1,2) g),'[]'::jsonb));
$$;
REVOKE ALL ON FUNCTION app.connection_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.connection_snapshot() TO porchday_jobs;
