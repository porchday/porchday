-- Opt-in only: old invitations and clients never promised a connection.
ALTER TABLE public.pilot_invitations ADD COLUMN connection_kind text CHECK(connection_kind IN('friend','family'));
ALTER TABLE public.pilot_invitations ADD COLUMN revoked_at timestamptz;
ALTER TABLE public.platform_invitation_history ADD COLUMN connection_kind text CHECK(connection_kind IN('friend','family'));
ALTER TABLE public.platform_invitation_history ADD COLUMN revoked_at timestamptz;
ALTER TABLE public.platform_invitation_history ADD COLUMN connection_checked_at timestamptz;

-- Verification and sender revocation serialize on the same receipt. The pair
-- lock precedes receipt locks, as in ordinary connection acceptance. No backfill
-- connects legacy members, and re-verification cannot resurrect a removed link.
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
     INSERT INTO app.connections(member_a,member_b,kind,kind_a,kind_b)
      VALUES(least(receipt.sender_id::uuid,NEW.id::uuid),greatest(receipt.sender_id::uuid,NEW.id::uuid),receipt.connection_kind,receipt.connection_kind,receipt.connection_kind);
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

-- Enforce revocation for old API readers as well as new ones.
CREATE OR REPLACE FUNCTION public.check_platform_invitation_claim() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$ BEGIN
 IF NEW.consumed_user IS NOT NULL AND OLD.consumed_user IS NULL
  AND (NEW.revoked_at IS NOT NULL OR (NEW.sender_id IS NOT NULL AND app.platform_inviter(NEW.sender_id) IS NULL)) THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
