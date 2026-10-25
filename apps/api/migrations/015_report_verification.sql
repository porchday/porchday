-- Explicitly disclosed evidence may outlive the reporter account for the stated
-- safety retention window. Preserve its public verification key, never a private
-- key, so deletion of an account cannot invalidate already disclosed signatures.
ALTER TABLE app.reports ADD COLUMN evidence_author_key text;
CREATE FUNCTION app.bind_report_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NEW.evidence_envelope IS NULL THEN NEW.evidence_author_key:=NULL;RETURN NEW;END IF;
 IF NOT NEW.evidence_disclosed OR NEW.evidence_envelope->'context'->>'kind'<>'report' OR NEW.evidence_envelope->'context'->>'audience'<>'moderators' OR NEW.evidence_envelope->'context'->>'authorId'<>NEW.reporter::text THEN RAISE EXCEPTION 'INVALID_REPORT_EVIDENCE';END IF;
 SELECT public_key INTO NEW.evidence_author_key FROM app.device_keys WHERE id=(NEW.evidence_envelope->'context'->>'authorDeviceId')::uuid AND member_id=NEW.reporter AND revoked_at IS NULL;
 IF NEW.evidence_author_key IS NULL THEN RAISE EXCEPTION 'INVALID_REPORT_EVIDENCE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_report_evidence BEFORE INSERT ON app.reports FOR EACH ROW EXECUTE FUNCTION app.bind_report_evidence();
CREATE OR REPLACE FUNCTION app.report_author_key(subject text,report uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE result jsonb;BEGIN
 PERFORM app.require_moderator(subject);
 SELECT jsonb_build_object('id',r.evidence_envelope->'context'->>'authorDeviceId','member_id',r.evidence_envelope->'context'->>'authorId','public_key',r.evidence_author_key) INTO result FROM app.reports r WHERE r.id=report AND r.evidence_disclosed AND r.evidence_author_key IS NOT NULL;
 IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND';END IF;
 INSERT INTO app.moderation_access_audit(staff_subject,report_id,operation) VALUES(subject,report,'read_evidence_author_key');RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.bind_report_evidence() FROM PUBLIC;
