GRANT USAGE ON SCHEMA public TO porchday_auth;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.auth_user,public.auth_session,public.auth_account,public.auth_verification,public.pilot_invitations,public.auth_rate_limits TO porchday_auth;
