-- Counts-only view of server connections for issue #40. Returns, per runtime
-- role and state, how many client backends exist and the age of the oldest
-- open transaction, plus the server's connection limits. Without
-- pg_read_all_stats the owner sees other sessions' state as NULL; those
-- connections are still counted, as state 'unknown'. No queries, client
-- addresses, application names, user identities or database names leave
-- this function. Additive; older Workers never call it.
CREATE FUNCTION app.connection_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object(
  'max_connections',current_setting('max_connections')::int,
  'reserved_connections',current_setting('superuser_reserved_connections')::int,
  'groups',coalesce((SELECT jsonb_agg(g) FROM (
   -- Hosted logins are provider usernames that inherit one runtime role.
   -- USAGE (inherited membership) excludes the administrator's
   -- non-inheriting administration grants.
   SELECT CASE WHEN usesysid IS NULL THEN 'other'
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
