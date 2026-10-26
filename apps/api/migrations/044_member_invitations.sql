-- A member can invite a new person, without creating a connection or exposing
-- whether that email already belongs to an account. Existing operator-issued
-- invitations retain a NULL sender and their original admission behavior.
ALTER TABLE public.pilot_invitations ADD COLUMN sender_id text
 REFERENCES public.auth_user(id) ON DELETE CASCADE;
CREATE INDEX pilot_invitation_recipient ON public.pilot_invitations(email,expires_at)
 WHERE consumed_user IS NULL;
CREATE INDEX auth_user_email_folded ON public.auth_user(lower(email));

-- Seven-day bounded abuse metadata. Recipient keys are keyed HMACs, never email
-- addresses. Keep a recipient cooldown after sender deletion without retaining
-- the deleted sender's identity. Runtime social/jobs roles have no access.
CREATE TABLE public.platform_invitation_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 sender_id text REFERENCES public.auth_user(id) ON DELETE SET NULL,
 recipient_key text NOT NULL CHECK(recipient_key ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 issued boolean NOT NULL DEFAULT false
);
CREATE INDEX platform_invitation_sender_window ON public.platform_invitation_requests(sender_id,created_at);
CREATE INDEX platform_invitation_recipient_window ON public.platform_invitation_requests(recipient_key,created_at) WHERE issued;
REVOKE ALL ON public.platform_invitation_requests FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.platform_invitation_requests TO porchday_auth;

CREATE FUNCTION app.platform_inviter(member text) RETURNS text LANGUAGE sql STABLE
 SECURITY DEFINER SET search_path=pg_catalog,app,public AS $$
 SELECT p.handle FROM app.members m JOIN app.profiles p ON p.member_id=m.id
 JOIN public.auth_user u ON u.id=m.id::text
 WHERE m.id::text=member AND m.status='active' AND u."emailVerified"
$$;
REVOKE ALL ON FUNCTION app.platform_inviter(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_inviter(text) TO porchday_auth;

CREATE FUNCTION public.platform_invitation_deliverable(token text) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT FROM public.pilot_invitations i WHERE i.token_hash=token
  AND i.sender_id IS NOT NULL AND i.consumed_user IS NULL AND i.expires_at>now()
  AND app.platform_inviter(i.sender_id) IS NOT NULL
  AND NOT EXISTS(SELECT FROM public.auth_user u WHERE lower(u.email)=i.email))
$$;
REVOKE ALL ON FUNCTION public.platform_invitation_deliverable(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_invitation_deliverable(text) TO porchday_auth;

CREATE FUNCTION public.check_platform_invitation_claim() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$ BEGIN
 IF NEW.sender_id IS NOT NULL AND NEW.consumed_user IS NOT NULL
  AND OLD.consumed_user IS NULL AND app.platform_inviter(NEW.sender_id) IS NULL
 THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.check_platform_invitation_claim() FROM PUBLIC;
CREATE TRIGGER platform_invitation_claim BEFORE UPDATE OF consumed_user ON public.pilot_invitations
 FOR EACH ROW EXECUTE FUNCTION public.check_platform_invitation_claim();

ALTER TABLE public.auth_email_outbox ADD COLUMN invitation_token_hash text
 REFERENCES public.pilot_invitations(token_hash) ON DELETE CASCADE;
ALTER TABLE public.auth_email_outbox DROP CONSTRAINT auth_email_outbox_purpose_check;
ALTER TABLE public.auth_email_outbox ADD CONSTRAINT auth_email_outbox_purpose_check
 CHECK(purpose IN ('account','case_contact','case_restore','case_security','platform_invitation'));
ALTER TABLE public.auth_email_outbox DROP CONSTRAINT email_principal;
ALTER TABLE public.auth_email_outbox ADD CONSTRAINT email_principal CHECK(
 (purpose='account' AND member_id IS NOT NULL AND recovery_case_id IS NULL AND invitation_token_hash IS NULL)
 OR (purpose IN ('case_contact','case_restore','case_security') AND recovery_case_id IS NOT NULL AND member_id IS NULL AND invitation_token_hash IS NULL)
 OR (purpose='platform_invitation' AND member_id IS NOT NULL AND recovery_case_id IS NULL AND invitation_token_hash IS NOT NULL)
);
-- Restore already purges pilot_invitations and auth_email_outbox. The FK also
-- invalidates queued invitations on expiry cleanup or sender account deletion.
