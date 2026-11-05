-- A photo has one encrypted conversation across its existing sharing paths.
-- New readers do not receive old comments/reactions automatically.
CREATE TABLE app.photo_interactions (
 id uuid PRIMARY KEY,
 photo_id uuid NOT NULL REFERENCES app.photos(id) ON DELETE CASCADE,
 author_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('comment','reaction')),
 envelope jsonb NOT NULL,
 author_key jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photo_interactions_photo ON app.photo_interactions(photo_id,created_at,id);
CREATE UNIQUE INDEX photo_one_reaction ON app.photo_interactions(photo_id,author_id) WHERE kind='reaction';
ALTER TABLE app.photo_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.photo_interactions FORCE ROW LEVEL SECURITY;
CREATE POLICY photo_interactions_read ON app.photo_interactions FOR SELECT USING(
 app.can_photo(photo_id) AND NOT app.blocked(author_id,app.actor())
 AND EXISTS(SELECT FROM jsonb_array_elements(envelope->'recipients') r WHERE r->>'memberId'=app.actor()::text));
CREATE POLICY photo_interactions_insert ON app.photo_interactions FOR INSERT WITH CHECK(
 app.may_write() AND app.can_photo(photo_id) AND author_id=app.actor());
CREATE POLICY photo_interactions_delete ON app.photo_interactions FOR DELETE USING(
 app.may_write() AND app.can_photo(photo_id) AND(author_id=app.actor() OR EXISTS(SELECT FROM app.photos p WHERE p.id=photo_id AND p.owner_id=app.actor())));
GRANT SELECT,INSERT,DELETE ON app.photo_interactions TO porchday_social;

CREATE FUNCTION app.photo_interaction_members(p uuid) RETURNS TABLE(member_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.may_write() OR NOT app.can_photo(p) THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 RETURN QUERY SELECT DISTINCT m.id FROM app.photos photo JOIN app.members m ON m.status IN('active','restricted')
 WHERE photo.id=p AND NOT app.blocked(photo.owner_id,m.id) AND NOT app.blocked(app.actor(),m.id)
 AND(m.id=photo.owner_id OR EXISTS(
 SELECT FROM app.photo_grants g JOIN app.photo_grant_recipients r ON r.grant_id=g.id AND r.member_id=m.id
 WHERE g.photo_id=p AND CASE WHEN g.album_id IS NOT NULL THEN EXISTS(
 SELECT FROM app.album_members am JOIN app.albums a ON a.id=am.album_id
 WHERE am.album_id=g.album_id AND am.member_id=m.id AND NOT app.blocked(a.owner_id,m.id))
 ELSE (g.audience='connections' AND app.connected(photo.owner_id,m.id))
 OR(g.audience='friends' AND app.friends(photo.owner_id,m.id))
 OR(g.audience='family' AND app.connected(photo.owner_id,m.id,true))
 OR(g.audience IN('community','extended_family') AND app.in_circle(photo.owner_id,m.id,g.audience='extended_family')) END));
END $$;
CREATE FUNCTION app.photo_interaction_devices(p uuid) RETURNS TABLE(id uuid,member_id uuid,public_key text,fingerprint text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT d.id,d.member_id,d.public_key,d.fingerprint FROM app.device_keys d JOIN app.photo_interaction_members(p) m ON m.member_id=d.member_id WHERE d.revoked_at IS NULL ORDER BY d.id
$$;
REVOKE ALL ON FUNCTION app.photo_interaction_members(uuid),app.photo_interaction_devices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.photo_interaction_members(uuid),app.photo_interaction_devices(uuid) TO porchday_social;

-- A restored backup must never resurrect removed comments or reactions.
CREATE FUNCTION app.journal_photo_interaction() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 INSERT INTO app.deletion_ledger(kind,object_id) VALUES('photo_interactions',OLD.id) ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
CREATE TRIGGER journal_photo_interaction AFTER DELETE ON app.photo_interactions FOR EACH ROW EXECUTE FUNCTION app.journal_photo_interaction();
REVOKE ALL ON FUNCTION app.journal_photo_interaction() FROM PUBLIC;
DO $migration$
DECLARE definition text;needle text:=$n$'photos','photo_grants')$n$;
BEGIN
 SELECT pg_get_functiondef('app.replay_safety_batch(jsonb)'::regprocedure) INTO definition;
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_RESTORE_READER';END IF;
 EXECUTE replace(definition,needle,$n$'photos','photo_grants','photo_interactions')$n$);
END $migration$;
-- Readers can verify a comment from an album member who is not a connection.
DO $migration$
DECLARE definition text;needle text:='LIMIT 1';
BEGIN
 SELECT pg_get_functiondef('app.author_key(uuid)'::regprocedure) INTO definition;
 IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'UNRECOGNIZED_AUTHOR_KEY_READER';END IF;
 EXECUTE replace(definition,needle,$new$UNION ALL SELECT (i.author_key->>'id')::uuid,(i.author_key->>'member_id')::uuid,i.author_key->>'public_key',i.author_key->>'fingerprint',NULL::timestamptz
 FROM app.photo_interactions i WHERE i.author_key->>'id'=d::text AND app.can_photo(i.photo_id) AND NOT app.blocked(i.author_id,app.actor())
 AND EXISTS(SELECT FROM jsonb_array_elements(i.envelope->'recipients') r WHERE r->>'memberId'=app.actor()::text)
 LIMIT 1$new$);
END $migration$;
-- Retried writes cannot resurrect an interaction already removed/replaced.
CREATE FUNCTION app.photo_interaction_removed(p uuid,i uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.can_photo(p) AND EXISTS(SELECT FROM app.deletion_ledger WHERE kind='photo_interactions' AND object_id=i)
$$;
REVOKE ALL ON FUNCTION app.photo_interaction_removed(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.photo_interaction_removed(uuid,uuid) TO porchday_social;
-- Name lookup follows the same addressed/current-photo/blocked checks.
DO $migration$
DECLARE definition text;needle text:='OR EXISTS(SELECT FROM app.comments c WHERE';
BEGIN
 SELECT pg_get_functiondef('app.member_handles(uuid[])'::regprocedure) INTO definition;
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_MEMBER_HANDLES';END IF;
 EXECUTE replace(definition,needle,$new$OR EXISTS(SELECT FROM app.photo_interactions i WHERE i.author_id=p.member_id AND app.can_photo(i.photo_id) AND EXISTS(SELECT FROM jsonb_array_elements(i.envelope->'recipients') r WHERE r->>'memberId'=app.actor()::text)) $new$||needle);
END $migration$;
-- Export only the member's own contributions, retaining the photo reference.
DO $migration$
DECLARE definition text;needle text;
BEGIN
 SELECT pg_get_functiondef('app.export_window(text,timestamptz,text,integer,text)'::regprocedure) INTO definition;
 needle:='UNION ALL SELECT g.group_id::text';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_EXPORT_WINDOW';END IF;
 EXECUTE replace(definition,needle,$new$UNION ALL SELECT i.id::text,to_jsonb(i)||jsonb_build_object('effective_expires_at',p.expires_at,'parent_id',i.photo_id) FROM app.photo_interactions i JOIN app.photos p ON p.id=i.photo_id WHERE section='photo_interactions' AND i.author_id=app.actor() AND i.created_at<=snapshot_at AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())
 UNION ALL SELECT g.group_id::text$new$);
 SELECT pg_get_functiondef('app.export_page(uuid,text,text)'::regprocedure) INTO definition;
 needle:='''photos'',''albums'',''attachment_dates''';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_EXPORT_PAGE';END IF;
 EXECUTE replace(definition,needle,needle||',''photo_interactions''');
 SELECT pg_get_functiondef('app.validate_export(uuid,jsonb)'::regprocedure) INTO definition;
 needle:='WHEN ''media'' THEN ''media''';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_EXPORT_VALIDATION';END IF;
 EXECUTE replace(definition,needle,needle||' WHEN ''photo_interaction'' THEN ''photo_interactions''');
END $migration$;
CREATE FUNCTION app.invalidate_photo_interaction_export() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 UPDATE app.data_transfer_jobs SET state='invalidated' WHERE member_id=OLD.author_id AND kind='export' AND state IN('pending','complete');RETURN NULL;
END $$;
CREATE TRIGGER invalidate_photo_interaction_export AFTER DELETE ON app.photo_interactions FOR EACH ROW EXECUTE FUNCTION app.invalidate_photo_interaction_export();
REVOKE ALL ON FUNCTION app.invalidate_photo_interaction_export() FROM PUBLIC;
