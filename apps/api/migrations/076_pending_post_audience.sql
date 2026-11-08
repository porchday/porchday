-- Pending delivery is metadata only: no plaintext, key, or read grant is stored.
-- Tie eligibility to this exact connection, so disconnect/reconnect cannot revive it.
CREATE TABLE app.pending_post_members (
 post_id uuid NOT NULL REFERENCES app.posts(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL REFERENCES app.connections(id) ON DELETE CASCADE,
 PRIMARY KEY(post_id,member_id)
);
ALTER TABLE app.pending_post_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.pending_post_members FROM PUBLIC;
CREATE FUNCTION app.capture_pending_post_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.author_id=app.actor() AND NEW.group_id IS NULL AND NEW.audience IN('connections','friends','family') THEN
  INSERT INTO app.pending_post_members(post_id,member_id,connection_id)
   SELECT NEW.id,m.member_id,c.id FROM app.pending_audience_members(NEW.audience,NULL,NULL) m
   JOIN app.connections c ON c.member_a=least(NEW.author_id,m.member_id) AND c.member_b=greatest(NEW.author_id,m.member_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_pending_post_members AFTER INSERT ON app.posts FOR EACH ROW EXECUTE FUNCTION app.capture_pending_post_members();
-- Conservatively discard pending eligibility on relabeling or blocking. Current
-- audience checks still apply at every refresh, and deletion cascades above.
CREATE FUNCTION app.revoke_pending_post_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF TG_TABLE_NAME='connections' THEN
  IF OLD.kind_a IS DISTINCT FROM NEW.kind_a OR OLD.kind_b IS DISTINCT FROM NEW.kind_b THEN
   DELETE FROM app.pending_post_members WHERE connection_id=NEW.id;
  END IF;
 ELSE
  DELETE FROM app.pending_post_members pending USING app.posts p WHERE pending.post_id=p.id
   AND ((p.author_id=NEW.actor AND pending.member_id=NEW.target) OR (p.author_id=NEW.target AND pending.member_id=NEW.actor));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revoke_pending_post_labels AFTER UPDATE OF kind_a,kind_b ON app.connections FOR EACH ROW EXECUTE FUNCTION app.revoke_pending_post_members();
CREATE TRIGGER revoke_pending_post_blocks AFTER INSERT ON app.blocks FOR EACH ROW EXECUTE FUNCTION app.revoke_pending_post_members();
REVOKE ALL ON FUNCTION app.capture_pending_post_members(),app.revoke_pending_post_members() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.history_audience_members(p uuid) RETURNS TABLE(member_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE source app.posts;
BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT * INTO source FROM app.posts WHERE id=p AND author_id=app.actor()
  AND group_id IS NULL AND audience IN('connections','friends','family','community','extended_family')
  AND(expires_at IS NULL OR expires_at>statement_timestamp());
 IF source.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 RETURN QUERY SELECT current.member_id FROM app.audience_members(source.audience,NULL,NULL) current
 WHERE source.audience IN('community','extended_family') OR current.member_id=app.actor()
 OR EXISTS(SELECT FROM app.post_recipients r WHERE r.post_id=p AND r.member_id=current.member_id)
 OR EXISTS(SELECT FROM app.pending_post_members pending WHERE pending.post_id=p AND pending.member_id=current.member_id)
 OR EXISTS(SELECT FROM app.connections c WHERE c.member_a=least(app.actor(),current.member_id)
  AND c.member_b=greatest(app.actor(),current.member_id)
  AND CASE WHEN c.member_a=app.actor() THEN c.history_a ELSE c.history_b END='full')
 ORDER BY current.member_id;
END $$;

