-- Export only owned logical photos and owned albums. Other album membership is
-- inert reference data, never permission to export another contributor's work.
CREATE INDEX photo_export_key ON app.photos(owner_id,(id::text));
CREATE INDEX album_export_key ON app.albums(owner_id,(id::text));
DO $migration$
DECLARE definition text;needle text;
BEGIN
 SELECT pg_get_functiondef('app.export_window(text,timestamptz,text,integer,text)'::regprocedure) INTO definition;
 needle:='UNION ALL SELECT g.group_id::text';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_EXPORT_WINDOW';END IF;
 definition:=replace(definition,needle,$new$
 UNION ALL SELECT p.id::text,to_jsonb(p)||jsonb_build_object('photo_date',p.photo_date::text,'grants',coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM app.photo_grants g WHERE g.photo_id=p.id AND g.album_id IS NULL),'[]'::jsonb),'album_ids',coalesce((SELECT jsonb_agg(g.album_id ORDER BY g.album_id) FROM app.photo_grants g WHERE g.photo_id=p.id AND g.album_id IS NOT NULL),'[]'::jsonb)) FROM app.photos p WHERE section='photos' AND p.owner_id=app.actor() AND p.created_at<=snapshot_at AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())
 UNION ALL SELECT a.id::text,to_jsonb(a) FROM app.albums a WHERE section='albums' AND a.owner_id=app.actor() AND a.created_at<=snapshot_at
 UNION ALL SELECT d.media_id::text,to_jsonb(d)||jsonb_build_object('post_id',m.post_id,'effective_expires_at',app.media_deadline(m.id)) FROM app.attachment_photo_dates d JOIN app.media_assets m ON m.id=d.media_id WHERE section='attachment_dates' AND d.photo_date IS NOT NULL AND m.owner_id=app.actor() AND m.created_at<=snapshot_at AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp())
 UNION ALL SELECT g.group_id::text$new$);
 needle:='section=''media'' AND m.owner_id=app.actor()';
 definition:=replace(definition,needle,needle||' AND NOT EXISTS(SELECT 1 FROM app.photo_grants pg WHERE pg.media_id=m.id AND pg.album_id IS NOT NULL)');
 EXECUTE definition;
 SELECT pg_get_functiondef('app.export_page(uuid,text,text)'::regprocedure) INTO definition;
 needle:='''media'',''connections'',''groups''';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_EXPORT_PAGE';END IF;
 EXECUTE replace(definition,needle,'''media'',''connections'',''groups'',''photos'',''albums'',''attachment_dates''');
 SELECT pg_get_functiondef('app.validate_export(uuid,jsonb)'::regprocedure) INTO definition;
 needle:='WHEN ''media'' THEN ''media''';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_EXPORT_VALIDATION';END IF;
 definition:=replace(definition,needle,needle||' WHEN ''photo'' THEN ''photos'' WHEN ''album'' THEN ''albums'' WHEN ''attachment_date'' THEN ''attachment_dates''');
 needle:='(row->''envelope''->''context''->>''revision'')::integer';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_EXPORT_REVISION';END IF;
 EXECUTE replace(definition,needle,' coalesce((row->>''revision'')::integer,(row->''envelope''->''context''->>''revision'')::integer)');
END $migration$;
CREATE FUNCTION app.invalidate_photo_export() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE owner uuid;other_owner uuid;
BEGIN
 IF TG_TABLE_NAME='photos' THEN owner:=coalesce(NEW.owner_id,OLD.owner_id);
 ELSIF TG_TABLE_NAME='photo_grants' THEN SELECT owner_id INTO owner FROM app.photos WHERE id=coalesce(NEW.photo_id,OLD.photo_id);
 ELSIF TG_TABLE_NAME='albums' THEN owner:=OLD.owner_id;other_owner:=NEW.owner_id;
 ELSE SELECT owner_id INTO owner FROM app.media_assets WHERE id=coalesce(NEW.media_id,OLD.media_id);
 END IF;
 UPDATE app.data_transfer_jobs SET state='invalidated' WHERE member_id IN(owner,other_owner) AND kind='export' AND state IN('pending','complete');
 RETURN NULL;
END $$;
CREATE TRIGGER invalidate_photo_export AFTER UPDATE OR DELETE ON app.photos FOR EACH ROW EXECUTE FUNCTION app.invalidate_photo_export();
CREATE TRIGGER invalidate_photo_grant_export AFTER INSERT OR UPDATE OR DELETE ON app.photo_grants FOR EACH ROW EXECUTE FUNCTION app.invalidate_photo_export();
CREATE TRIGGER invalidate_album_export AFTER UPDATE OR DELETE ON app.albums FOR EACH ROW EXECUTE FUNCTION app.invalidate_photo_export();
CREATE TRIGGER invalidate_attachment_date_export AFTER INSERT OR UPDATE OR DELETE ON app.attachment_photo_dates FOR EACH ROW EXECUTE FUNCTION app.invalidate_photo_export();
REVOKE ALL ON FUNCTION app.invalidate_photo_export() FROM PUBLIC;
