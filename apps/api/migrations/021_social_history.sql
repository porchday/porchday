CREATE FUNCTION app.revoke_family_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF OLD.kind='family' AND NEW.kind='friend' THEN
  DELETE FROM app.post_recipients r USING app.posts p WHERE r.post_id=p.id AND p.audience='family' AND((p.author_id=OLD.member_a AND r.member_id=OLD.member_b) OR(p.author_id=OLD.member_b AND r.member_id=OLD.member_a));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER revoke_family_history AFTER UPDATE OF kind ON app.connections FOR EACH ROW EXECUTE FUNCTION app.revoke_family_history();
CREATE FUNCTION app.monotonic_envelope_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$ BEGIN
 IF NEW.envelope IS DISTINCT FROM OLD.envelope AND(NEW.envelope->'context'->>'revision')::integer IS DISTINCT FROM coalesce((OLD.envelope->'context'->>'revision')::integer,0)+1 THEN RAISE EXCEPTION 'REVISION_CHANGED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_revision BEFORE UPDATE OF envelope ON app.profiles FOR EACH ROW EXECUTE FUNCTION app.monotonic_envelope_revision();
CREATE TRIGGER group_revision BEFORE UPDATE OF envelope ON app.groups FOR EACH ROW EXECUTE FUNCTION app.monotonic_envelope_revision();
REVOKE ALL ON FUNCTION app.revoke_family_history(),app.monotonic_envelope_revision() FROM PUBLIC;
CREATE INDEX posts_wall_cursor ON app.posts(created_at DESC,id DESC) WHERE group_id IS NULL;
