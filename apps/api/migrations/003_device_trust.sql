CREATE TABLE app.recovery_keys (
 member_id uuid PRIMARY KEY REFERENCES app.members ON DELETE CASCADE,
 public_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.device_challenges (
 member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 device_id uuid PRIMARY KEY,
 public_key text NOT NULL,
 fingerprint text NOT NULL,
 challenge text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz
);
ALTER TABLE app.recovery_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.device_challenges ENABLE ROW LEVEL SECURITY;
CREATE POLICY recovery_self ON app.recovery_keys USING(member_id=app.actor() AND app.may_read()) WITH CHECK(member_id=app.actor() AND app.may_write());
CREATE POLICY challenge_self ON app.device_challenges USING(member_id=app.actor() AND app.may_read()) WITH CHECK(member_id=app.actor() AND app.may_write());
GRANT SELECT,INSERT ON app.recovery_keys TO porchday_social;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.device_challenges TO porchday_social;
-- Only a trusted member may see their own device roster. Other keys are returned
-- through scoped directory helpers, never by enumerating this table.
DROP POLICY devices_read ON app.device_keys;
CREATE POLICY devices_read ON app.device_keys FOR SELECT USING(app.may_read() AND member_id=app.actor());
CREATE FUNCTION app.author_key(d uuid) RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text,revoked_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT k.id,k.member_id,k.public_key,k.fingerprint,k.revoked_at FROM app.device_keys k WHERE k.id=d AND app.may_read() AND(k.member_id=app.actor() OR app.connected(k.member_id,app.actor()) OR EXISTS(SELECT FROM app.posts p WHERE p.envelope->'context'->>'authorDeviceId'=d::text AND app.can_post(p.id)) OR EXISTS(SELECT FROM app.comments c WHERE c.envelope->'context'->>'authorDeviceId'=d::text AND app.can_comment(c.id)) OR EXISTS(SELECT FROM app.group_memberships a JOIN app.group_memberships b USING(group_id) WHERE a.member_id=k.member_id AND b.member_id=app.actor()))
$$;
REVOKE ALL ON FUNCTION app.author_key(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.author_key(uuid) TO porchday_social;
