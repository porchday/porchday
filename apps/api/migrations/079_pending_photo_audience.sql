-- Pending delivery is metadata only: no plaintext, key, or read grant is stored.
-- Tie eligibility to this exact connection, so disconnect/reconnect cannot revive it.
CREATE TABLE app.pending_photo_members (
 grant_id uuid NOT NULL REFERENCES app.photo_grants(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL REFERENCES app.connections(id) ON DELETE CASCADE,
 PRIMARY KEY(grant_id,member_id)
);
ALTER TABLE app.pending_photo_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.pending_photo_members FROM PUBLIC;
CREATE FUNCTION app.capture_pending_photo_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF EXISTS(SELECT FROM app.photos p WHERE p.id=NEW.photo_id AND p.owner_id=app.actor()) AND NEW.album_id IS NULL AND NEW.audience IN('connections','friends','family') THEN
  INSERT INTO app.pending_photo_members(grant_id,member_id,connection_id)
   SELECT NEW.id,m.member_id,c.id FROM app.pending_audience_members(NEW.audience,NULL,NULL) m
   JOIN app.connections c ON c.member_a=least(app.actor(),m.member_id) AND c.member_b=greatest(app.actor(),m.member_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capture_pending_photo_members AFTER INSERT ON app.photo_grants FOR EACH ROW EXECUTE FUNCTION app.capture_pending_photo_members();
-- Conservatively discard pending eligibility on relabeling or blocking. Current
-- audience checks still apply at every refresh, and deletion cascades above.
CREATE FUNCTION app.revoke_pending_photo_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF TG_TABLE_NAME='connections' THEN
  IF OLD.kind_a IS DISTINCT FROM NEW.kind_a OR OLD.kind_b IS DISTINCT FROM NEW.kind_b THEN
   DELETE FROM app.pending_photo_members WHERE connection_id=NEW.id;
  END IF;
 ELSE
  DELETE FROM app.pending_photo_members pending USING app.photo_grants g,app.photos p WHERE pending.grant_id=g.id AND g.photo_id=p.id
   AND ((p.owner_id=NEW.actor AND pending.member_id=NEW.target) OR (p.owner_id=NEW.target AND pending.member_id=NEW.actor));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revoke_pending_photo_labels AFTER UPDATE OF kind_a,kind_b ON app.connections FOR EACH ROW EXECUTE FUNCTION app.revoke_pending_photo_members();
CREATE TRIGGER revoke_pending_photo_blocks AFTER INSERT ON app.blocks FOR EACH ROW EXECUTE FUNCTION app.revoke_pending_photo_members();
REVOKE ALL ON FUNCTION app.capture_pending_photo_members(),app.revoke_pending_photo_members() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.photo_refresh_members(g uuid) RETURNS TABLE(member_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE grant_row app.photo_grants;photo app.photos;
BEGIN
 SELECT * INTO grant_row FROM app.photo_grants WHERE id=g;
 SELECT * INTO photo FROM app.photos WHERE id=grant_row.photo_id;
 IF NOT app.may_write() OR photo.id IS NULL OR NOT app.can_photo_grant(g) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF grant_row.album_id IS NULL THEN
  IF photo.owner_id<>app.actor() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
  RETURN QUERY SELECT current.member_id FROM app.audience_members(grant_row.audience,NULL,NULL) current
  WHERE grant_row.audience IN('community','extended_family') OR current.member_id=app.actor()
   OR EXISTS(SELECT FROM app.photo_grant_recipients r WHERE r.grant_id=g AND r.member_id=current.member_id)
   OR EXISTS(SELECT FROM app.pending_photo_members pending WHERE pending.grant_id=g AND pending.member_id=current.member_id)
   OR EXISTS(SELECT FROM app.connections c WHERE c.member_a=least(app.actor(),current.member_id)
    AND c.member_b=greatest(app.actor(),current.member_id)
    AND CASE WHEN c.member_a=app.actor() THEN c.history_a ELSE c.history_b END='full');
  RETURN;
 END IF;
 IF app.album_role(grant_row.album_id) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 RETURN QUERY SELECT m.id FROM app.members m WHERE m.status IN('active','restricted') AND NOT app.blocked(photo.owner_id,m.id)
 AND(m.id=photo.owner_id OR EXISTS(SELECT FROM app.album_members am JOIN app.albums a ON a.id=am.album_id WHERE am.album_id=grant_row.album_id AND am.member_id=m.id AND NOT app.blocked(a.owner_id,m.id)));
END $$;
