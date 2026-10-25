ALTER TABLE public.staff_users ADD COLUMN IF NOT EXISTS roles text[] NOT NULL DEFAULT '{}';
CREATE TABLE app.moderator_identities (
 subject text PRIMARY KEY REFERENCES public.staff_users(subject),
 id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
CREATE TABLE app.moderator_keys (
 id uuid PRIMARY KEY REFERENCES app.device_keys(id) ON DELETE CASCADE,
 staff_subject text NOT NULL REFERENCES public.staff_users(subject),
 member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,
 public_key text NOT NULL,
 fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz
);
CREATE TABLE app.moderation_access_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 staff_subject text NOT NULL,
 report_id uuid,
 operation text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.reports ADD COLUMN parent_report uuid REFERENCES app.reports(id) ON DELETE SET NULL;
ALTER TABLE app.moderation_actions ADD COLUMN staff_subject text REFERENCES public.staff_users(subject);
ALTER TABLE app.moderator_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.moderator_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.moderation_access_audit ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION app.require_moderator(subject text) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NOT EXISTS(SELECT FROM public.staff_users s WHERE s.subject=$1 AND s.active AND 'moderation'=ANY(s.roles)) THEN RAISE EXCEPTION 'STAFF_FORBIDDEN'; END IF;
END $$;
CREATE FUNCTION app.register_moderator_key(subject text,device uuid,member uuid,key text,fp text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 PERFORM app.require_moderator(subject);
 IF NOT EXISTS(SELECT FROM app.device_keys d JOIN app.members m ON m.id=d.member_id JOIN public.auth_user u ON u.id=m.id::text JOIN public.staff_users s ON lower(s.email)=lower(u.email) WHERE s.subject=$1 AND u."emailVerified" AND d.id=device AND d.member_id=member AND d.public_key=key AND d.fingerprint=fp AND d.revoked_at IS NULL AND m.status='active') THEN RAISE EXCEPTION 'STAFF_KEY_MISMATCH'; END IF;
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 INSERT INTO app.moderator_identities(subject) VALUES(subject) ON CONFLICT DO NOTHING;
 INSERT INTO app.moderator_keys(id,staff_subject,member_id,public_key,fingerprint) VALUES(device,subject,member,key,fp) ON CONFLICT(id) DO NOTHING;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 INSERT INTO app.moderation_access_audit(staff_subject,operation) VALUES(subject,'register_evidence_key');
END $$;
CREATE FUNCTION app.staff_moderator_keys(subject text) RETURNS SETOF app.moderator_keys LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 PERFORM app.require_moderator(subject);RETURN QUERY SELECT * FROM app.moderator_keys k WHERE k.staff_subject=$1 ORDER BY created_at;
END $$;
CREATE FUNCTION app.revoke_moderator_key(subject text,device uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 PERFORM app.require_moderator(subject);PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 UPDATE app.moderator_keys SET revoked_at=now() WHERE id=device AND staff_subject=subject;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 INSERT INTO app.moderation_access_audit(staff_subject,operation) VALUES(subject,'revoke_evidence_key');
END $$;
CREATE FUNCTION app.moderator_devices() RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT k.id,k.member_id,k.public_key,k.fingerprint FROM app.moderator_keys k JOIN public.staff_users s ON s.subject=k.staff_subject JOIN app.device_keys d ON d.id=k.id JOIN app.members m ON m.id=k.member_id WHERE app.may_read() AND k.revoked_at IS NULL AND d.revoked_at IS NULL AND s.active AND 'moderation'=ANY(s.roles) AND m.status='active' ORDER BY k.id
$$;
CREATE FUNCTION app.staff_reports(subject text,state_filter text DEFAULT NULL,before_time timestamptz DEFAULT NULL,before_id uuid DEFAULT NULL) RETURNS TABLE(id uuid,reporter uuid,target_member uuid,target_id uuid,reason text,status text,evidence_disclosed boolean,parent_report uuid,created_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 PERFORM app.require_moderator(subject);
 INSERT INTO app.moderation_access_audit(staff_subject,operation) VALUES(subject,'list_reports');
 RETURN QUERY SELECT r.id,r.reporter,r.target_member,r.target_id,r.reason,r.status,r.evidence_disclosed,r.parent_report,r.created_at FROM app.reports r WHERE(state_filter IS NULL OR r.status=state_filter) AND(before_time IS NULL OR(r.created_at,r.id)<(before_time,before_id)) ORDER BY r.created_at DESC,r.id DESC LIMIT 51;
END $$;
CREATE FUNCTION app.staff_report(subject text,report uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE result jsonb; BEGIN
 PERFORM app.require_moderator(subject);
 SELECT to_jsonb(r) INTO result FROM app.reports r WHERE id=report;
 IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 INSERT INTO app.moderation_access_audit(staff_subject,report_id,operation) VALUES(subject,report,'read_disclosed_evidence');
 RETURN result;
END $$;
CREATE FUNCTION app.report_author_key(subject text,report uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE result jsonb; BEGIN
 PERFORM app.require_moderator(subject);
 SELECT jsonb_build_object('id',d.id,'member_id',d.member_id,'public_key',d.public_key,'fingerprint',d.fingerprint) INTO result FROM app.reports r JOIN app.device_keys d ON d.id=(r.evidence_envelope->'context'->>'authorDeviceId')::uuid WHERE r.id=report AND r.evidence_disclosed AND d.member_id=r.reporter;
 IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 INSERT INTO app.moderation_access_audit(staff_subject,report_id,operation) VALUES(subject,report,'read_evidence_author_key');RETURN result;
END $$;
CREATE FUNCTION app.moderate_report(subject text,report uuid,decision text,reason_code text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r app.reports;actor_id uuid;action_id uuid;
BEGIN
 PERFORM app.require_moderator(subject);
 IF decision NOT IN('review','resolve','restrict','suspend','restore','remove_content') OR reason_code!~'^[a-z_]{3,60}$' THEN RAISE EXCEPTION 'INVALID_ACTION';END IF;
 PERFORM 1 FROM app.directory_epoch WHERE id FOR UPDATE;
 SELECT * INTO r FROM app.reports WHERE id=report FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF r.reason='appeal' AND decision<>'review' AND EXISTS(SELECT FROM app.moderation_actions a WHERE a.report_id=r.parent_report AND a.staff_subject=subject AND a.action IN('restrict','suspend','remove_content')) THEN RAISE EXCEPTION 'INDEPENDENT_REVIEW_REQUIRED'; END IF;
 INSERT INTO app.moderator_identities(subject) VALUES(subject) ON CONFLICT DO NOTHING;
 SELECT id INTO actor_id FROM app.moderator_identities WHERE moderator_identities.subject=$1;
 IF decision IN('restrict','suspend') THEN
  UPDATE app.members SET status=CASE WHEN decision='restrict' THEN 'restricted' ELSE 'suspended' END WHERE id=r.target_member AND status IN('active','restricted','suspended');
  IF NOT FOUND THEN RAISE EXCEPTION 'SECURITY_CASE_REQUIRED'; END IF;
  UPDATE app.integration_grants SET revoked_at=now(),access_hash=NULL,refresh_hash=NULL,code_hash=NULL WHERE member_id=r.target_member;
  IF decision='suspend' THEN DELETE FROM public.auth_session WHERE "userId"=r.target_member::text; END IF;
 ELSIF decision='restore' THEN
  UPDATE app.members SET status='active' WHERE id=r.target_member AND status IN('restricted','suspended');
  IF NOT FOUND THEN RAISE EXCEPTION 'SECURITY_CASE_REQUIRED'; END IF;
 ELSIF decision='remove_content' THEN
  DELETE FROM app.posts WHERE id=r.target_id AND author_id=r.target_member;
  IF NOT FOUND THEN DELETE FROM app.comments WHERE id=r.target_id AND author_id=r.target_member; END IF;
 END IF;
 UPDATE app.reports SET status=CASE WHEN decision='review' THEN 'reviewing' ELSE 'resolved' END WHERE id=report;
 INSERT INTO app.moderation_actions(report_id,staff_id,staff_subject,member_id,action,reason_code) VALUES(report,actor_id,subject,r.target_member,decision,reason_code) RETURNING id INTO action_id;
 INSERT INTO app.moderation_access_audit(staff_subject,report_id,operation) VALUES(subject,report,'action_'||decision);
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 RETURN action_id;
END $$;
CREATE FUNCTION app.member_moderation_actions() RETURNS TABLE(id uuid,report_id uuid,action text,reason_code text,created_at timestamptz) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT id,report_id,action,reason_code,created_at FROM app.moderation_actions WHERE member_id=app.actor() ORDER BY created_at DESC LIMIT 100 $$;
CREATE FUNCTION app.submit_appeal(action_id uuid,evidence jsonb DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE a app.moderation_actions;report_id uuid:=gen_random_uuid();BEGIN
 SELECT * INTO a FROM app.moderation_actions WHERE id=action_id AND member_id=app.actor();
 IF a.id IS NULL OR NOT EXISTS(SELECT FROM app.members WHERE id=app.actor() AND status<>'deleted') THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 IF EXISTS(SELECT FROM app.reports WHERE reporter=app.actor() AND reason='appeal' AND target_id=action_id AND status IN('received','reviewing')) THEN RAISE EXCEPTION 'APPEAL_PENDING'; END IF;
 INSERT INTO app.reports(id,reporter,target_member,target_id,reason,evidence_envelope,evidence_disclosed,parent_report) VALUES(report_id,app.actor(),app.actor(),action_id,'appeal',evidence,evidence IS NOT NULL,a.report_id);
 RETURN report_id;
END $$;
REVOKE ALL ON FUNCTION app.require_moderator(text),app.register_moderator_key(text,uuid,uuid,text,text),app.staff_moderator_keys(text),app.revoke_moderator_key(text,uuid),app.moderator_devices(),app.staff_reports(text,text,timestamptz,uuid),app.staff_report(text,uuid),app.report_author_key(text,uuid),app.moderate_report(text,uuid,text,text),app.member_moderation_actions(),app.submit_appeal(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_moderator_key(text,uuid,uuid,text,text),app.staff_moderator_keys(text),app.revoke_moderator_key(text,uuid),app.staff_reports(text,text,timestamptz,uuid),app.staff_report(text,uuid),app.report_author_key(text,uuid),app.moderate_report(text,uuid,text,text) TO porchday_auth;
GRANT EXECUTE ON FUNCTION app.moderator_devices(),app.member_moderation_actions(),app.submit_appeal(uuid,jsonb) TO porchday_social;
