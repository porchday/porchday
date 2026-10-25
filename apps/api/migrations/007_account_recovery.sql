CREATE TABLE public.recovery_cases (
 id uuid PRIMARY KEY, account_reference text NOT NULL, safe_email text NOT NULL,
 contact_token_hash text NOT NULL UNIQUE, contact_token_expires_at timestamptz NOT NULL,
 contact_verified_at timestamptz, session_hash text UNIQUE, session_expires_at timestamptz,
 state text NOT NULL DEFAULT 'contact_pending' CHECK(state IN('contact_pending','submitted','reviewing','hold','restored','denied')),
 member_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 retention_until timestamptz NOT NULL DEFAULT now()+interval '90 days'
);
CREATE TABLE public.staff_users(subject text PRIMARY KEY,email text NOT NULL,active boolean NOT NULL DEFAULT true);
CREATE TABLE public.recovery_reviews (
 case_id uuid REFERENCES public.recovery_cases(id) ON DELETE CASCADE,
 reviewer text REFERENCES public.staff_users(subject),
 decision text NOT NULL CHECK(decision IN('hold','restore','deny')),
 evidence_reference text NOT NULL CHECK(length(evidence_reference) BETWEEN 1 AND 500),
 reviewed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(case_id,reviewer,decision)
);
CREATE TABLE public.security_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),staff_subject text,action text NOT NULL,
 target uuid,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.used_email_links(token_hash text PRIMARY KEY,expires_at timestamptz NOT NULL);
REVOKE ALL ON public.recovery_cases,public.staff_users,public.recovery_reviews,public.security_audit,public.used_email_links FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.recovery_cases,public.recovery_reviews,public.used_email_links TO porchday_auth;
GRANT SELECT ON public.staff_users TO porchday_auth;
GRANT INSERT ON public.security_audit TO porchday_auth;
