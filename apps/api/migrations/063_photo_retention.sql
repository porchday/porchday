-- Extend the currently installed retention function rather than replacing its
-- existing post/media cleanup behavior with a historical copy.
CREATE INDEX photos_expiry ON app.photos(expires_at,id) WHERE expires_at IS NOT NULL;
DO $migration$
DECLARE definition text;needle text;
BEGIN
 SELECT pg_get_functiondef('app.expire_batch(integer)'::regprocedure) INTO definition;
 IF (length(definition)-length(replace(definition,'DECLARE','')))/length('DECLARE')<>1 THEN RAISE EXCEPTION 'UNRECOGNIZED_RETENTION_WORKER';END IF;
 definition:=replace(definition,'DECLARE','DECLARE photo_count integer;');
 needle:='DELETE FROM app.posts WHERE id IN(';
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'UNRECOGNIZED_RETENTION_WORKER';END IF;
 definition:=replace(definition,needle,'DELETE FROM app.photos WHERE id IN(SELECT id FROM app.photos WHERE expires_at<=now() ORDER BY expires_at,id LIMIT batch_size FOR UPDATE SKIP LOCKED);GET DIAGNOSTICS photo_count=ROW_COUNT; '||needle);
 needle:='RETURN jsonb_build_object(';
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'UNRECOGNIZED_RETENTION_WORKER';END IF;
 EXECUTE replace(definition,needle,needle||'''photos'',photo_count,');
END $migration$;
