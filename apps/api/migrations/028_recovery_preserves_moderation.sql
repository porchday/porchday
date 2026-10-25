-- Account ownership recovery cannot undo an independent moderation decision.
ALTER TABLE app.members ADD COLUMN status_before_security_hold text
 CHECK(status_before_security_hold IN ('active','restricted','suspended'));

-- An older hold has no trustworthy prior-state record. Fail closed until a
-- separate moderation review restores privileges; never infer active status.
UPDATE app.members SET status_before_security_hold='suspended' WHERE status='hold';

CREATE OR REPLACE FUNCTION app.set_security_hold(member uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE previous text;
BEGIN
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 SELECT status INTO previous FROM app.members WHERE id=member FOR UPDATE;
 IF previous IS NULL OR previous NOT IN ('active','restricted','suspended','hold') THEN
  RAISE EXCEPTION 'ACCOUNT_UNAVAILABLE';
 END IF;
 IF previous<>'hold' THEN
  UPDATE app.members SET status_before_security_hold=previous,status='hold' WHERE id=member;
 END IF;
 UPDATE app.integration_grants SET revoked_at=now(),access_hash=NULL,refresh_hash=NULL,code_hash=NULL WHERE member_id=member;
 UPDATE app.data_transfer_jobs SET state='invalidated' WHERE member_id=member;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
END $$;

CREATE OR REPLACE FUNCTION app.recovery_restore(staff text,member uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,public AS $$
DECLARE restored_status text;
BEGIN
 IF NOT EXISTS(SELECT FROM public.staff_users WHERE subject=staff AND active AND 'recovery'=ANY(roles)) THEN
  RAISE EXCEPTION 'FORBIDDEN';
 END IF;
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 SELECT coalesce(status_before_security_hold,'suspended') INTO restored_status
  FROM app.members WHERE id=member AND status='hold' FOR UPDATE;
 IF restored_status IS NULL THEN RAISE EXCEPTION 'HOLD_REQUIRED'; END IF;
 UPDATE app.device_keys SET revoked_at=now() WHERE member_id=member AND revoked_at IS NULL;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 UPDATE app.members SET status=restored_status,status_before_security_hold=NULL WHERE id=member;
END $$;

REVOKE ALL ON FUNCTION app.set_security_hold(uuid),app.recovery_restore(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_security_hold(uuid),app.recovery_restore(text,uuid) TO porchday_auth;

CREATE INDEX recovery_cases_staff_queue ON public.recovery_cases(created_at,id)
 WHERE contact_verified_at IS NOT NULL;
CREATE INDEX recovery_cases_staff_state_queue ON public.recovery_cases(state,created_at,id)
 WHERE contact_verified_at IS NOT NULL;
