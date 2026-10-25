-- Integration bytes obey the same media/parent deadline as metadata pages,
-- independently of delayed physical cleanup.
CREATE OR REPLACE FUNCTION app.integration_media(token_hash text,media uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE result text;
BEGIN
 SELECT m.object_key INTO result
 FROM app.integration_grants ig JOIN app.members u ON u.id=ig.member_id
 JOIN app.media_assets m ON m.owner_id=ig.member_id
 WHERE m.id=media AND m.state IN('ready','attached')
 AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp())
 AND ig.access_hash=token_hash AND 'media:read'=ANY(ig.scopes)
 AND ig.access_expires_at>now() AND ig.expires_at>now() AND ig.revoked_at IS NULL
 AND u.status IN('active','restricted');
 IF result IS NULL THEN RAISE EXCEPTION 'INVALID_GRANT';END IF;RETURN result;
END $$;

-- Only opaque grant IDs, operation class and short-lived aggregate counts.
CREATE TABLE app.integration_rate_limits(
 grant_id uuid NOT NULL REFERENCES app.integration_grants ON DELETE CASCADE,
 bucket bigint NOT NULL,
 operation text NOT NULL CHECK(operation IN('read','token')),
 count integer NOT NULL CHECK(count>0),
 PRIMARY KEY(grant_id,bucket,operation)
);
CREATE INDEX integration_rate_limits_bucket ON app.integration_rate_limits(bucket);
ALTER TABLE app.integration_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.integration_rate_limits FROM PUBLIC,porchday_social,porchday_auth,porchday_jobs;

-- Autocommit this preflight before token exchange/resource SQL. Failed PKCE,
-- scope and resource checks must not roll back an already-consumed attempt.
-- Return -1 for an invalid credential, 0 for allowed, or Retry-After seconds.
CREATE FUNCTION app.integration_request_limit(token_hash text,kind text,client uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE g_id uuid;b bigint:=floor(extract(epoch FROM statement_timestamp())/60);
 op text;maximum integer;n integer;
BEGIN
 IF token_hash!~'^[a-f0-9]{64}$' OR kind NOT IN('read','authorization_code','refresh_token') THEN RETURN -1;END IF;
 SELECT g.id INTO g_id FROM app.integration_grants g JOIN app.members m ON m.id=g.member_id
 WHERE g.revoked_at IS NULL AND g.expires_at>now() AND m.status IN('active','restricted')
 AND CASE kind
  WHEN 'read' THEN g.access_hash=token_hash AND g.access_expires_at>now()
  WHEN 'authorization_code' THEN g.client_id=client AND g.code_hash=token_hash AND g.code_expires_at>now()
  WHEN 'refresh_token' THEN g.client_id=client AND g.refresh_hash=token_hash
 END;
 IF g_id IS NULL THEN RETURN -1;END IF;
 op:=CASE WHEN kind='read' THEN 'read' ELSE 'token' END;
 maximum:=CASE WHEN kind='read' THEN 120 ELSE 10 END;
 INSERT INTO app.integration_rate_limits AS rates(grant_id,bucket,operation,count)
 VALUES(g_id,b,op,1) ON CONFLICT(grant_id,bucket,operation)
 DO UPDATE SET count=least(rates.count+1,maximum+1) RETURNING count INTO n;
 -- Bounded opportunistic retention; inactive grants also cascade on deletion.
 DELETE FROM app.integration_rate_limits WHERE(grant_id,bucket,operation) IN(
  SELECT r.grant_id,r.bucket,r.operation FROM app.integration_rate_limits r
  WHERE r.bucket<b-2 ORDER BY r.bucket LIMIT 1000 FOR UPDATE SKIP LOCKED
 );
 RETURN CASE WHEN n<=maximum THEN 0 ELSE 60-mod(floor(extract(epoch FROM statement_timestamp()))::bigint,60)::integer END;
END $$;
REVOKE ALL ON FUNCTION app.integration_request_limit(text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.integration_request_limit(text,text,uuid) TO porchday_social;
