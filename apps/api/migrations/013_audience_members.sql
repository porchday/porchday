-- Historical audiences are member sets. A newly trusted device may receive future
-- replies for those members, but old ciphertext remains encrypted to its original
-- device keys until an authorized author explicitly re-encrypts it.
CREATE FUNCTION app.audience_members(audience text,g uuid DEFAULT NULL,p uuid DEFAULT NULL) RETURNS TABLE(member_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF p IS NOT NULL AND NOT app.can_post(p) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF audience='group' AND NOT app.in_group(g,app.actor()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN QUERY SELECT m.id FROM app.members m WHERE m.status IN('active','restricted') AND NOT app.blocked(m.id,app.actor()) AND(
 CASE WHEN p IS NOT NULL THEN EXISTS(SELECT FROM app.posts p0 WHERE p0.id=p AND NOT app.blocked(m.id,p0.author_id) AND(m.id=p0.author_id OR(EXISTS(SELECT FROM app.post_recipients pr WHERE pr.post_id=p AND pr.member_id=m.id) AND((p0.audience='connections' AND app.connected(p0.author_id,m.id)) OR(p0.audience='family' AND app.connected(p0.author_id,m.id,true)) OR(p0.audience='group' AND app.in_group(p0.group_id,m.id))))))
 ELSE m.id=app.actor() OR(audience='connections' AND app.connected(app.actor(),m.id)) OR(audience='family' AND app.connected(app.actor(),m.id,true)) OR(audience='group' AND app.in_group(g,m.id)) END
 ) ORDER BY m.id;
END $$;
CREATE OR REPLACE FUNCTION app.audience_devices(audience text,g uuid DEFAULT NULL,p uuid DEFAULT NULL) RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT d.id,d.member_id,d.public_key,d.fingerprint FROM app.device_keys d JOIN app.audience_members(audience,g,p) m USING(member_id) WHERE d.revoked_at IS NULL ORDER BY d.id
$$;
CREATE FUNCTION app.pending_audience_members(audience text,g uuid DEFAULT NULL,p uuid DEFAULT NULL) RETURNS TABLE(member_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT m.member_id FROM app.audience_members(audience,g,p) m WHERE NOT EXISTS(SELECT FROM app.device_keys d WHERE d.member_id=m.member_id AND d.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION app.audience_members(text,uuid,uuid),app.pending_audience_members(text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_audience_members(text,uuid,uuid) TO porchday_social;
