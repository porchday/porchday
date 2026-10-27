-- History sharing is an independent choice in each direction of a connection.
-- Existing connections and older clients retain future-only behavior.
ALTER TABLE app.connection_requests ADD COLUMN history text NOT NULL DEFAULT 'future'
 CHECK(history IN('future','full'));
ALTER TABLE app.connections ADD COLUMN history_a text NOT NULL DEFAULT 'future'
 CHECK(history_a IN('future','full'));
ALTER TABLE app.connections ADD COLUMN history_b text NOT NULL DEFAULT 'future'
 CHECK(history_b IN('future','full'));

CREATE FUNCTION app.accept_connection_with_history(request_id uuid,own_history text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r app.connection_requests; result uuid;
BEGIN
 IF NOT app.may_write() OR own_history NOT IN('future','full') OR own_history IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO r FROM app.connection_requests WHERE id=request_id;
 IF r.recipient IS DISTINCT FROM app.actor() THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM app.lock_pair(r.sender,r.recipient);
 SELECT * INTO r FROM app.connection_requests WHERE id=request_id FOR UPDATE;
 -- A repeated acceptance must never change a previously recorded choice.
 IF r.state='accepted' THEN
  SELECT id INTO result FROM app.connections WHERE member_a=least(r.sender,r.recipient) AND member_b=greatest(r.sender,r.recipient);
  IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  RETURN result;
 END IF;
 IF r.state<>'pending' OR app.blocked(r.sender,r.recipient) OR NOT EXISTS(SELECT FROM app.members WHERE id=r.sender AND status='active') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF (SELECT count(*) FROM app.connections WHERE r.sender IN(member_a,member_b))>=300 OR (SELECT count(*) FROM app.connections WHERE r.recipient IN(member_a,member_b))>=300 THEN RAISE EXCEPTION 'CONNECTION_LIMIT'; END IF;
 INSERT INTO app.connections(member_a,member_b,kind,history_a,history_b)
 VALUES(least(r.sender,r.recipient),greatest(r.sender,r.recipient),r.kind,
  CASE WHEN r.sender<r.recipient THEN r.history ELSE own_history END,
  CASE WHEN r.sender<r.recipient THEN own_history ELSE r.history END) RETURNING id INTO result;
 UPDATE app.connection_requests SET state='accepted' WHERE id=request_id;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 INSERT INTO app.notifications(recipient,actor,kind,dedupe_key) VALUES(r.sender,r.recipient,'connection_accepted','connection:'||request_id) ON CONFLICT DO NOTHING;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION app.accept_connection(request_id uuid) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.accept_connection_with_history(request_id,'future')
$$;

CREATE FUNCTION app.set_connection_history(connection_id uuid,history text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r app.connections;
BEGIN
 IF NOT app.may_write() OR history NOT IN('future','full') OR history IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO r FROM app.connections WHERE id=connection_id;
 IF r.id IS NULL OR app.actor() NOT IN(r.member_a,r.member_b) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM app.lock_pair(r.member_a,r.member_b);
 SELECT * INTO r FROM app.connections WHERE id=connection_id FOR UPDATE;
 IF r.id IS NULL OR app.actor() NOT IN(r.member_a,r.member_b) OR app.blocked(r.member_a,r.member_b) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF (CASE WHEN r.member_a=app.actor() THEN r.history_a ELSE r.history_b END)=history THEN RETURN; END IF;
 UPDATE app.connections SET
  history_a=CASE WHEN member_a=app.actor() THEN history ELSE history_a END,
  history_b=CASE WHEN member_b=app.actor() THEN history ELSE history_b END
 WHERE id=connection_id;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
END $$;

-- Restricting future catch-up must survive a database restore. Reuse the
-- conservative relationship-removal replay already used for relabeling; a stale
-- restored full-history preference must not regenerate unconsented grants.
CREATE FUNCTION app.capture_connection_history_restriction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF (OLD.history_a='full' AND NEW.history_a='future') OR (OLD.history_b='full' AND NEW.history_b='future') THEN
  PERFORM app.append_safety_decision(jsonb_build_object('action','connection','a',OLD.member_a,'b',OLD.member_b));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_connection_history AFTER UPDATE OF history_a,history_b ON app.connections
 FOR EACH ROW EXECUTE FUNCTION app.capture_connection_history_restriction();

CREATE FUNCTION app.history_audience_members(p uuid) RETURNS TABLE(member_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE source app.posts;
BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO source FROM app.posts WHERE id=p AND author_id=app.actor()
  AND group_id IS NULL AND audience IN('connections','friends','family')
  AND (expires_at IS NULL OR expires_at>statement_timestamp());
 IF source.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN QUERY SELECT current.member_id FROM app.audience_members(source.audience,NULL,NULL) current
 WHERE current.member_id=app.actor()
  OR EXISTS(SELECT FROM app.post_recipients r WHERE r.post_id=p AND r.member_id=current.member_id)
  OR EXISTS(SELECT FROM app.connections c WHERE c.member_a=least(app.actor(),current.member_id)
   AND c.member_b=greatest(app.actor(),current.member_id)
   AND CASE WHEN c.member_a=app.actor() THEN c.history_a ELSE c.history_b END='full')
 ORDER BY current.member_id;
END $$;
CREATE FUNCTION app.history_audience_devices(p uuid)
RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT d.id,d.member_id,d.public_key,d.fingerprint FROM app.device_keys d
 JOIN app.history_audience_members(p) m USING(member_id)
 WHERE d.revoked_at IS NULL ORDER BY d.id
$$;
REVOKE ALL ON FUNCTION app.accept_connection_with_history(uuid,text),app.set_connection_history(uuid,text),app.capture_connection_history_restriction(),app.history_audience_members(uuid),app.history_audience_devices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_connection_with_history(uuid,text),app.set_connection_history(uuid,text),app.history_audience_members(uuid),app.history_audience_devices(uuid) TO porchday_social;
