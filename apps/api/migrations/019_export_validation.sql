-- Recheck immediately before releasing client-created archive parts. A copy
-- already saved by a member cannot be remotely erased; clients disclose this.
CREATE FUNCTION app.validate_export(job uuid,refs jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE j app.data_transfer_jobs;ref jsonb;row jsonb;section text;deadline timestamptz;BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 SELECT * INTO j FROM app.data_transfer_jobs WHERE id=job AND member_id=app.actor() AND kind='export' AND state='complete' AND expires_at>statement_timestamp();
 IF j.id IS NULL THEN RAISE EXCEPTION 'EXPORT_INVALIDATED';END IF;
 IF jsonb_typeof(refs)<>'array' OR jsonb_array_length(refs)>1000 THEN RAISE EXCEPTION 'INVALID_EXPORT_REFS';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(refs) LOOP
  section:=CASE ref->>'kind' WHEN 'profile' THEN 'profile' WHEN 'post' THEN 'posts' WHEN 'comment' THEN 'comments' WHEN 'post_reaction' THEN 'post_reactions' WHEN 'comment_reaction' THEN 'comment_reactions' WHEN 'media' THEN 'media' END;
  IF section IS NULL THEN RETURN false;END IF;
  SELECT item INTO row FROM app.export_items(section,j.created_at) WHERE export_id=ref->>'id';
  IF row IS NULL OR(row->'envelope'->'context'->>'revision')::integer IS DISTINCT FROM(ref->>'revision')::integer THEN RETURN false;END IF;
  deadline:=least((row->>'effective_expires_at')::timestamptz,(row->>'expires_at')::timestamptz,(row->'envelope'->'context'->>'expiresAt')::timestamptz);
  IF deadline IS DISTINCT FROM(ref->>'expires_at')::timestamptz OR deadline<=statement_timestamp() THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
-- Invalidates an in-progress export when a photo is removed/replaced as well.
CREATE FUNCTION app.invalidate_media_export() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 UPDATE app.data_transfer_jobs SET state='invalidated' WHERE member_id=OLD.owner_id AND kind='export' AND state IN('pending','complete');RETURN OLD;
END $$;
CREATE TRIGGER invalidate_media_export BEFORE DELETE ON app.media_assets FOR EACH ROW EXECUTE FUNCTION app.invalidate_media_export();
REVOKE ALL ON FUNCTION app.validate_export(uuid,jsonb),app.invalidate_media_export() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.validate_export(uuid,jsonb) TO porchday_social;
