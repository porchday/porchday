-- Owner-only, bounded metadata view; no invitation envelopes or private profiles.
CREATE FUNCTION app.owner_group_invitations(target uuid, before_at timestamptz DEFAULT NULL, before_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid,recipient_handle text,inviter_handle text,expires_at timestamptz,accepted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.may_read() OR NOT EXISTS(SELECT FROM app.groups g WHERE g.id=target AND g.owner_id=app.actor()) THEN
  RAISE EXCEPTION 'FORBIDDEN';
 END IF;
 RETURN QUERY SELECT i.id,
  CASE WHEN NOT app.blocked(i.recipient,app.actor()) THEN r.handle END,
  CASE WHEN NOT app.blocked(i.inviter,app.actor()) THEN s.handle END,
  i.expires_at,i.accepted_at
 FROM app.group_invitations i
 LEFT JOIN app.profiles r ON r.member_id=i.recipient
 LEFT JOIN app.profiles s ON s.member_id=i.inviter
 WHERE i.group_id=target AND (before_at IS NULL OR (i.expires_at,i.id)<(before_at,before_id))
 ORDER BY i.expires_at DESC,i.id DESC LIMIT 31;
END $$;
REVOKE ALL ON FUNCTION app.owner_group_invitations(uuid,timestamptz,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.owner_group_invitations(uuid,timestamptz,uuid) TO porchday_social;
-- Reissued invitations name the manager who actually sent the latest invitation.
GRANT UPDATE(inviter) ON app.group_invitations TO porchday_social;
CREATE FUNCTION app.check_group_invitation_inviter() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.inviter IS DISTINCT FROM OLD.inviter AND NEW.inviter IS DISTINCT FROM app.actor() THEN
  RAISE EXCEPTION 'FORBIDDEN';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER group_invitation_inviter BEFORE UPDATE OF inviter ON app.group_invitations
FOR EACH ROW EXECUTE FUNCTION app.check_group_invitation_inviter();
