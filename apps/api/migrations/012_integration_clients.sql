-- Registered public clients disclose only consent metadata; ownership and grants
-- remain private. This permits another member to authorize a registered tool.
CREATE FUNCTION app.integration_client(client uuid) RETURNS TABLE(id uuid,name text,purpose text,redirect_uri text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT id,name,purpose,redirect_uri FROM app.integration_clients WHERE id=client AND app.may_read()
$$;
REVOKE ALL ON FUNCTION app.integration_client(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.integration_client(uuid) TO porchday_social;
