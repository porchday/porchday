-- Verification/reset links are encrypted in the durable outbox. No social
-- content or encryption recovery keys may enter account email.
CREATE TABLE public.auth_email_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 member_id text NOT NULL REFERENCES public.auth_user(id) ON DELETE CASCADE,
 encrypted_payload text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 leased_until timestamptz,
 lease_id uuid,
 delivered_at timestamptz,
 failed_at timestamptz
);
CREATE INDEX auth_email_pending ON public.auth_email_outbox(next_attempt_at)
 WHERE delivered_at IS NULL AND failed_at IS NULL;
REVOKE ALL ON public.auth_email_outbox FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.auth_email_outbox TO porchday_auth;
