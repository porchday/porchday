ALTER TABLE public.staff_users ADD COLUMN IF NOT EXISTS roles text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.staff_users ADD CONSTRAINT staff_roles_allowed CHECK(roles <@ ARRAY['recovery','moderation']::text[]);
ALTER TABLE public.auth_user ADD COLUMN "twoFactorEnabled" boolean NOT NULL DEFAULT false;
ALTER TABLE public.auth_user ADD COLUMN credentials_changed_at timestamptz;
CREATE TABLE public.auth_two_factor (
 id text PRIMARY KEY,"userId" text NOT NULL REFERENCES public.auth_user(id) ON DELETE CASCADE,
 secret text NOT NULL,"backupCodes" text NOT NULL,verified boolean NOT NULL DEFAULT false,
 "failedVerificationCount" integer NOT NULL DEFAULT 0,"lockedUntil" timestamptz
);
CREATE INDEX auth_two_factor_user ON public.auth_two_factor("userId");
REVOKE ALL ON public.auth_two_factor FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.auth_two_factor TO porchday_auth;
ALTER TABLE public.recovery_cases ADD COLUMN compromised_at timestamptz;
ALTER TABLE public.recovery_cases ADD COLUMN trusted_method text;
ALTER TABLE public.recovery_cases ADD COLUMN description text;
ALTER TABLE public.recovery_cases ADD COLUMN reason text;
ALTER TABLE public.recovery_cases ADD COLUMN assigned_to text REFERENCES public.staff_users(subject);
ALTER TABLE public.recovery_cases ADD COLUMN restore_token_hash text UNIQUE;
ALTER TABLE public.recovery_cases ADD COLUMN restore_token_expires_at timestamptz;
ALTER TABLE public.recovery_cases ADD COLUMN appeal_count integer NOT NULL DEFAULT 0;
CREATE TABLE public.recovery_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),case_id uuid NOT NULL REFERENCES public.recovery_cases(id) ON DELETE CASCADE,
 description text NOT NULL CHECK(length(description)<=2000),evidence_reference text CHECK(length(evidence_reference)<=500),
 created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.recovery_evidence FROM PUBLIC;
GRANT SELECT,INSERT,DELETE ON public.recovery_evidence TO porchday_auth;

-- Narrow identity lookup available only through the audited, JWT-protected staff API.
CREATE FUNCTION app.recovery_lookup(staff text,ref text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,public AS $$
DECLARE result uuid;
BEGIN
 IF NOT EXISTS(SELECT FROM public.staff_users WHERE subject=staff AND active AND 'recovery'=ANY(roles)) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT u.id::uuid INTO result FROM public.auth_user u JOIN app.profiles p ON p.member_id=u.id::uuid WHERE lower(u.email)=lower(ref) OR p.handle=lower(ref) LIMIT 1;
 RETURN result;
END $$;
CREATE FUNCTION app.recovery_restore(staff text,member uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,public AS $$ BEGIN
 IF NOT EXISTS(SELECT FROM public.staff_users WHERE subject=staff AND active AND 'recovery'=ANY(roles)) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 IF NOT EXISTS(SELECT FROM app.members WHERE id=member AND status='hold') THEN RAISE EXCEPTION 'HOLD_REQUIRED'; END IF;
 UPDATE app.device_keys SET revoked_at=now() WHERE member_id=member AND revoked_at IS NULL;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 UPDATE app.members SET status='active' WHERE id=member;
END $$;
REVOKE ALL ON FUNCTION app.recovery_lookup(text,text),app.recovery_restore(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recovery_lookup(text,text),app.recovery_restore(text,uuid) TO porchday_auth;
CREATE TABLE public.security_contact_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),member_id text NOT NULL REFERENCES public.auth_user(id) ON DELETE CASCADE,
 previous_email text NOT NULL,changed_at timestamptz NOT NULL DEFAULT now(),retention_until timestamptz NOT NULL DEFAULT now()+interval '90 days'
);
REVOKE ALL ON public.security_contact_history FROM PUBLIC;
CREATE FUNCTION public.remember_security_contact() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF OLD.email<>NEW.email AND OLD."emailVerified" THEN INSERT INTO public.security_contact_history(member_id,previous_email) VALUES(OLD.id,OLD.email); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER remember_security_contact AFTER UPDATE OF email ON public.auth_user FOR EACH ROW EXECUTE FUNCTION public.remember_security_contact();
REVOKE ALL ON FUNCTION public.remember_security_contact() FROM PUBLIC;
CREATE OR REPLACE FUNCTION app.recovery_lookup(staff text,ref text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,public AS $$
DECLARE result uuid;
BEGIN
 IF NOT EXISTS(SELECT FROM public.staff_users WHERE subject=staff AND active AND 'recovery'=ANY(roles)) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT u.id::uuid INTO result FROM public.auth_user u JOIN app.profiles p ON p.member_id=u.id::uuid WHERE lower(u.email)=lower(ref) OR p.handle=lower(ref) OR EXISTS(SELECT FROM public.security_contact_history h WHERE h.member_id=u.id AND lower(h.previous_email)=lower(ref) AND h.retention_until>now()) ORDER BY u."createdAt" LIMIT 1;
 RETURN result;
END $$;
GRANT DELETE ON public.security_contact_history TO porchday_auth;
