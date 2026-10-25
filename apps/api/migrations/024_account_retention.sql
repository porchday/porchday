-- Auth can prune its own historical login metadata; social runtime cannot read it.
GRANT SELECT,DELETE ON public.security_contact_history TO porchday_auth;
-- A reused prior email may refer to multiple accounts. Do not select an arbitrary
-- target; the claimant must identify an unambiguous handle and staff must verify it.
CREATE OR REPLACE FUNCTION app.recovery_lookup(staff text,ref text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,public AS $$
DECLARE candidates uuid[];
BEGIN
 IF NOT EXISTS(SELECT FROM public.staff_users WHERE subject=staff AND active AND 'recovery'=ANY(roles)) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT array_agg(DISTINCT u.id::uuid) INTO candidates FROM public.auth_user u JOIN app.profiles p ON p.member_id=u.id::uuid WHERE lower(u.email)=lower(ref) OR p.handle=lower(ref) OR EXISTS(SELECT FROM public.security_contact_history h WHERE h.member_id=u.id AND lower(h.previous_email)=lower(ref) AND h.retention_until>now());
 RETURN CASE WHEN array_length(candidates,1)=1 THEN candidates[1] ELSE NULL END;
END $$;
