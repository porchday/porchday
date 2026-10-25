-- Only an already-authenticated actor can inspect/lock their upload cleanup
-- state. Status changes may hide a ready object under RLS, so cleanup must not
-- interpret an invisible row as a missing reservation after ambiguous COMMIT.
CREATE FUNCTION app.lock_media_upload_cleanup(media uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE state text; actor uuid:=app.actor();
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT m.state INTO state FROM app.media_assets m WHERE m.id=media AND m.owner_id=actor FOR UPDATE;
 IF FOUND THEN
  RETURN state;
 END IF;
 IF EXISTS(SELECT FROM app.deletion_outbox WHERE object_key='media/'||actor::text||'/'||media::text) THEN RETURN 'deleted'; END IF;
 RETURN 'unavailable';
END $$;
REVOKE ALL ON FUNCTION app.lock_media_upload_cleanup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_media_upload_cleanup(uuid) TO porchday_social;
