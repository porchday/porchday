-- Preserve existing invitations and old clients with the current full-history default.
ALTER TABLE public.pilot_invitations ADD COLUMN connection_history text NOT NULL DEFAULT 'full' CHECK(connection_history IN('full','future'));
ALTER TABLE public.platform_invitation_history ADD COLUMN connection_history text NOT NULL DEFAULT 'full' CHECK(connection_history IN('full','future'));

-- Only the inviter's directional sharing is selected by this invitation.
CREATE OR REPLACE FUNCTION public.invitation_history_verified() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE candidate record; receipt public.platform_invitation_history;
BEGIN
 IF NOT NEW."emailVerified" OR (TG_OP='UPDATE' AND OLD."emailVerified") THEN RETURN NEW; END IF;
 FOR candidate IN SELECT id,sender_id FROM public.platform_invitation_history WHERE claimed_user=NEW.id ORDER BY id LOOP
  PERFORM app.lock_pair(candidate.sender_id::uuid,NEW.id::uuid);
  SELECT * INTO receipt FROM public.platform_invitation_history WHERE id=candidate.id FOR UPDATE;
  IF NOT FOUND OR receipt.claimed_user IS DISTINCT FROM NEW.id OR receipt.revoked_at IS NOT NULL THEN CONTINUE; END IF;
  IF receipt.connection_kind IS NOT NULL AND receipt.connection_checked_at IS NULL THEN
   -- Admission may finish if the inviter is no longer available, but never
   -- bypass a block or restore a relationship removed after first verification.
   IF app.platform_inviter(receipt.sender_id) IS NOT NULL
    AND EXISTS(SELECT FROM app.members WHERE id=NEW.id::uuid AND status='active')
    AND NOT app.blocked(receipt.sender_id::uuid,NEW.id::uuid)
    AND receipt.sender_id<>NEW.id THEN
    IF NOT EXISTS(SELECT FROM app.connections WHERE member_a=least(receipt.sender_id::uuid,NEW.id::uuid) AND member_b=greatest(receipt.sender_id::uuid,NEW.id::uuid)) THEN
     IF (SELECT count(*) FROM app.connections WHERE receipt.sender_id::uuid IN(member_a,member_b))>=300
      OR (SELECT count(*) FROM app.connections WHERE NEW.id::uuid IN(member_a,member_b))>=300 THEN RAISE EXCEPTION 'CONNECTION_LIMIT'; END IF;
     INSERT INTO app.connections(member_a,member_b,kind,kind_a,kind_b,history_a,history_b)
      VALUES(least(receipt.sender_id::uuid,NEW.id::uuid),greatest(receipt.sender_id::uuid,NEW.id::uuid),receipt.connection_kind,receipt.connection_kind,receipt.connection_kind,
       CASE WHEN receipt.sender_id::uuid<NEW.id::uuid THEN receipt.connection_history ELSE 'full' END,
       CASE WHEN receipt.sender_id::uuid>NEW.id::uuid THEN receipt.connection_history ELSE 'full' END);
     UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
     INSERT INTO app.notifications(recipient,actor,kind,dedupe_key)
      VALUES(receipt.sender_id::uuid,NEW.id::uuid,'connection_accepted','invitation-connection:'||receipt.id) ON CONFLICT DO NOTHING;
    END IF;
   END IF;
   UPDATE public.platform_invitation_history SET connection_checked_at=now() WHERE id=receipt.id;
  END IF;
  UPDATE public.platform_invitation_history SET joined_at=coalesce(joined_at,now()) WHERE id=receipt.id;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.invitation_history_verified() FROM PUBLIC;

