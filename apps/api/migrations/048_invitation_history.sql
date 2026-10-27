-- Sender-owned operational receipts, separate from admission credentials.
-- Addresses are encrypted by the application using its operational-mail key.
ALTER TABLE public.pilot_invitations ADD COLUMN history_recorded boolean NOT NULL DEFAULT false;
CREATE TABLE public.platform_invitation_history (
 id uuid PRIMARY KEY,
 sender_id text NOT NULL REFERENCES public.auth_user(id) ON DELETE CASCADE,
 recipient_key text NOT NULL CHECK(recipient_key ~ '^[a-f0-9]{64}$'),
 encrypted_recipient text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 invitation_token_hash text REFERENCES public.pilot_invitations(token_hash) ON DELETE SET NULL,
 claimed_user text,
 joined_at timestamptz,
 UNIQUE(sender_id,recipient_key)
);
CREATE INDEX invitation_history_sender ON public.platform_invitation_history(sender_id,requested_at DESC,id DESC);
CREATE INDEX invitation_history_claimant ON public.platform_invitation_history(claimed_user) WHERE claimed_user IS NOT NULL;
CREATE INDEX invitation_history_token ON public.platform_invitation_history(invitation_token_hash) WHERE invitation_token_hash IS NOT NULL;
REVOKE ALL ON public.platform_invitation_history FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.platform_invitation_history TO porchday_auth;

-- Claiming a code precedes auth-user creation and is not proof of joining.
-- Retain the claim through token expiry so a later email verification counts.
CREATE FUNCTION public.invitation_history_claim() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public AS $$ BEGIN
 UPDATE public.platform_invitation_history SET claimed_user=NEW.consumed_user
 WHERE invitation_token_hash=NEW.token_hash AND joined_at IS NULL;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.invitation_history_claim() FROM PUBLIC;
CREATE TRIGGER invitation_history_claim AFTER UPDATE OF consumed_user ON public.pilot_invitations
 FOR EACH ROW EXECUTE FUNCTION public.invitation_history_claim();

CREATE FUNCTION public.invitation_history_verified() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW."emailVerified" THEN
  UPDATE public.platform_invitation_history SET joined_at=coalesce(joined_at,now())
  WHERE claimed_user=NEW.id;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.invitation_history_verified() FROM PUBLIC;
CREATE TRIGGER invitation_history_verified AFTER INSERT OR UPDATE OF "emailVerified" ON public.auth_user
 FOR EACH ROW EXECUTE FUNCTION public.invitation_history_verified();

-- Do not expose subsequent deletion/status changes of an invited recipient.
CREATE FUNCTION public.invitation_history_recipient_removed() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public AS $$ BEGIN
 UPDATE public.platform_invitation_history SET claimed_user=NULL,
  joined_at=CASE WHEN OLD."emailVerified" THEN coalesce(joined_at,now()) ELSE joined_at END
 WHERE claimed_user=OLD.id;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.invitation_history_recipient_removed() FROM PUBLIC;
CREATE TRIGGER invitation_history_recipient_removed AFTER DELETE ON public.auth_user
 FOR EACH ROW EXECUTE FUNCTION public.invitation_history_recipient_removed();
