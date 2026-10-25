-- Authentication metadata only; private member content lives in encrypted app tables.
CREATE TABLE IF NOT EXISTS public.auth_user (
 id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 "emailVerified" boolean NOT NULL DEFAULT false, image text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.auth_session (
 id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 "ipAddress" text, "userAgent" text,
 "userId" text NOT NULL REFERENCES public.auth_user(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS auth_session_user_idx ON public.auth_session("userId");
CREATE TABLE IF NOT EXISTS public.auth_account (
 id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
 "userId" text NOT NULL REFERENCES public.auth_user(id) ON DELETE CASCADE,
 "accessToken" text, "refreshToken" text, "idToken" text,
 "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
 scope text, password text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE("providerId","accountId"), CHECK ("providerId"='credential')
);
CREATE INDEX IF NOT EXISTS auth_account_user_idx ON public.auth_account("userId");
CREATE TABLE IF NOT EXISTS public.auth_verification (
 id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL,
 "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_verification_identifier_idx ON public.auth_verification(identifier);
CREATE TABLE IF NOT EXISTS public.pilot_invitations (
 token_hash text PRIMARY KEY, email text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 consumed_user text UNIQUE, handle text,
 claimed_at timestamptz, adult_attested_at timestamptz, rules_accepted_at timestamptz,
 CHECK (handle IS NULL OR handle ~ '^[a-z0-9_]{3,24}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS pilot_invitation_handle ON public.pilot_invitations(handle) WHERE consumed_user IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
 key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL
);
REVOKE ALL ON public.auth_user,public.auth_session,public.auth_account,public.auth_verification,public.pilot_invitations,public.auth_rate_limits FROM PUBLIC;
