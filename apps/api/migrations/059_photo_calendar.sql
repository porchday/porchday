-- Expansion only. Child names and birthdays are separate encrypted documents;
-- routing/delegation IDs and personal highlight IDs are service metadata.
CREATE TABLE app.child_profiles (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 envelope jsonb NOT NULL CHECK(octet_length(envelope::text)<=524288), revision integer NOT NULL CHECK(revision>0),
 delegates uuid[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(cardinality(delegates)<=30)
);
CREATE TABLE app.child_private_details (
 child_id uuid PRIMARY KEY REFERENCES app.child_profiles(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 envelope jsonb NOT NULL CHECK(octet_length(envelope::text)<=131072)
);
CREATE TABLE app.calendar_highlights (
 member_id uuid NOT NULL REFERENCES app.members(id) ON DELETE CASCADE,
 day date NOT NULL, post_id uuid NOT NULL REFERENCES app.posts(id) ON DELETE CASCADE,
 media_id uuid, PRIMARY KEY(member_id,day)
);
ALTER TABLE app.posts ADD COLUMN on_behalf_of uuid REFERENCES app.child_profiles(id) ON DELETE SET NULL;
ALTER TABLE app.child_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.child_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.child_private_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.child_private_details FORCE ROW LEVEL SECURITY;
ALTER TABLE app.calendar_highlights ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.calendar_highlights FORCE ROW LEVEL SECURITY;
CREATE POLICY children_read ON app.child_profiles FOR SELECT USING((owner_id=app.actor() AND app.may_manage_data()) OR (app.may_read() AND app.connected(owner_id,app.actor())));
CREATE POLICY children_insert ON app.child_profiles FOR INSERT WITH CHECK(app.may_write() AND owner_id=app.actor());
CREATE POLICY children_update ON app.child_profiles FOR UPDATE USING(app.may_write() AND owner_id=app.actor()) WITH CHECK(owner_id=app.actor());
CREATE POLICY children_delete ON app.child_profiles FOR DELETE USING(app.may_write() AND owner_id=app.actor());
CREATE POLICY child_private_read ON app.child_private_details FOR SELECT USING(app.may_manage_data() AND owner_id=app.actor());
CREATE POLICY child_private_write ON app.child_private_details FOR ALL USING(app.may_write() AND owner_id=app.actor()) WITH CHECK(app.may_write() AND owner_id=app.actor() AND EXISTS(SELECT FROM app.child_profiles c WHERE c.id=child_id AND c.owner_id=app.actor()));
CREATE POLICY highlights_read ON app.calendar_highlights FOR SELECT USING(app.may_read() AND member_id=app.actor() AND app.can_post(post_id));
CREATE POLICY highlights_insert ON app.calendar_highlights FOR INSERT WITH CHECK(app.may_write() AND member_id=app.actor() AND app.can_post(post_id));
CREATE POLICY highlights_update ON app.calendar_highlights FOR UPDATE USING(app.may_write() AND member_id=app.actor()) WITH CHECK(app.may_write() AND member_id=app.actor() AND app.can_post(post_id));
CREATE POLICY highlights_delete ON app.calendar_highlights FOR DELETE USING(app.may_write() AND member_id=app.actor());
GRANT SELECT,INSERT,UPDATE,DELETE ON app.child_profiles,app.child_private_details,app.calendar_highlights TO porchday_social;
GRANT UPDATE(on_behalf_of) ON app.posts TO porchday_social;
CREATE INDEX child_profiles_owner ON app.child_profiles(owner_id);

-- Persist attribution permission checks below the HTTP layer too. Operations
-- share the directory lock with connection/block and delegation changes.
CREATE FUNCTION app.check_child_post_author() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$
DECLARE c app.child_profiles;
BEGIN
 IF NEW.on_behalf_of IS NULL THEN RETURN NEW; END IF;
 PERFORM app.lock_epoch();
 SELECT * INTO c FROM app.child_profiles WHERE id=NEW.on_behalf_of;
 IF c.id IS NULL OR NEW.author_id<>app.actor() OR NOT app.may_write() OR
   (c.owner_id<>app.actor() AND NOT(app.actor()=ANY(c.delegates) AND app.connected(c.owner_id,app.actor())))
 THEN RAISE EXCEPTION 'CHILD_POST_FORBIDDEN'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER child_post_author BEFORE INSERT OR UPDATE OF on_behalf_of ON app.posts FOR EACH ROW EXECUTE FUNCTION app.check_child_post_author();
-- Removing the relationship also revokes delegation permanently; reconnecting
-- must not silently reinstate a parent's earlier permission.
CREATE FUNCTION app.revoke_child_delegation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE a uuid; b uuid;
BEGIN
 IF TG_TABLE_NAME='connections' THEN a:=OLD.member_a; b:=OLD.member_b;
 ELSE a:=NEW.actor; b:=NEW.target; END IF;
 UPDATE app.child_profiles SET delegates=array_remove(delegates,b) WHERE owner_id=a AND b=ANY(delegates);
 UPDATE app.child_profiles SET delegates=array_remove(delegates,a) WHERE owner_id=b AND a=ANY(delegates);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.revoke_child_delegation() FROM PUBLIC;
CREATE TRIGGER child_delegation_disconnect AFTER DELETE ON app.connections FOR EACH ROW EXECUTE FUNCTION app.revoke_child_delegation();
CREATE TRIGGER child_delegation_block AFTER INSERT ON app.blocks FOR EACH ROW EXECUTE FUNCTION app.revoke_child_delegation();

CREATE FUNCTION app.journal_child_profile() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE removed uuid;
BEGIN
 UPDATE app.data_transfer_jobs SET state='invalidated' WHERE member_id=OLD.owner_id AND kind='export' AND state IN('pending','complete');
 IF TG_OP='DELETE' THEN
  INSERT INTO app.deletion_ledger(kind,object_id) VALUES('child_profiles',OLD.id) ON CONFLICT DO NOTHING;
  RETURN OLD;
 END IF;
 IF NEW.envelope IS DISTINCT FROM OLD.envelope THEN
  PERFORM app.append_safety_decision(jsonb_build_object('action','revision','kind','child_profiles','id',NEW.id,'revision',NEW.revision));
 END IF;
 FOR removed IN SELECT unnest(OLD.delegates) EXCEPT SELECT unnest(NEW.delegates) LOOP
  PERFORM app.append_safety_decision(jsonb_build_object('action','child_delegate','id',NEW.id,'member',removed));
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER journal_child_profile AFTER UPDATE OR DELETE ON app.child_profiles FOR EACH ROW EXECUTE FUNCTION app.journal_child_profile();
REVOKE ALL ON FUNCTION app.journal_child_profile(),app.check_child_post_author() FROM PUBLIC;

-- Keep the existing restore actions; stale child data and revoked delegates
-- must not reappear when replaying an older backup.
-- Extend the installed reader instead of replacing it with an older copy.
-- Staging may include the privacy-operation marker branch from migration 057.
DO $migration$
DECLARE definition text; old_fragment text; new_fragment text; replacements text[][];
BEGIN
 SELECT pg_get_functiondef('app.replay_safety_batch(jsonb)'::regprocedure) INTO definition;
 replacements:=ARRAY[
  ARRAY[$old$kind IN('posts','comments','groups','media_assets')$old$,$new$kind IN('posts','comments','groups','media_assets','child_profiles')$new$],
  ARRAY[$old$ELSIF kind='emoji_libraries' THEN$old$,$new$ELSIF kind='child_profiles' THEN DELETE FROM app.child_profiles WHERE id=(d->>'id')::uuid AND revision<(d->>'revision')::integer;
   ELSIF kind='emoji_libraries' THEN$new$],
  ARRAY[$old$WHEN 'connection' THEN$old$,$new$WHEN 'child_delegate' THEN UPDATE app.child_profiles SET delegates=array_remove(delegates,(d->>'member')::uuid) WHERE id=(d->>'id')::uuid;
  WHEN 'connection' THEN$new$]
 ];
 FOR i IN 1..array_length(replacements,1) LOOP
  old_fragment:=replacements[i][1]; new_fragment:=replacements[i][2];
  IF (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 THEN
   RAISE EXCEPTION 'UNRECOGNIZED_RESTORE_READER';
  END IF;
  definition:=replace(definition,old_fragment,new_fragment);
 END LOOP;
 EXECUTE definition;
END $migration$;

-- Include the owner's encrypted child records in the existing bounded profile export.
CREATE OR REPLACE FUNCTION app.export_window(section text,snapshot_at timestamptz,after_id text,take_count integer,exact_id text) RETURNS TABLE(export_id text,item jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT owned.export_id,owned.item FROM (
 SELECT p.member_id::text,to_jsonb(p)||jsonb_build_object('children',coalesce((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('private_envelope',d.envelope) ORDER BY c.id) FROM app.child_profiles c LEFT JOIN app.child_private_details d ON d.child_id=c.id WHERE c.owner_id=app.actor() AND c.created_at<=snapshot_at),'[]'::jsonb)) FROM app.profiles p WHERE section='profile' AND p.member_id=app.actor()
 UNION ALL SELECT e.member_id::text,to_jsonb(e) FROM app.emoji_libraries e WHERE section='emoji_library' AND e.member_id=app.actor() AND e.envelope IS NOT NULL
 UNION ALL SELECT p.id::text,to_jsonb(p) FROM app.posts p WHERE section='posts' AND p.author_id=app.actor() AND p.stored_at<=snapshot_at AND(p.expires_at IS NULL OR p.expires_at>statement_timestamp())
 UNION ALL SELECT c.id::text,to_jsonb(c)||jsonb_build_object('effective_expires_at',app.comment_deadline(c.id)) FROM app.comments c WHERE section='comments' AND c.author_id=app.actor() AND c.stored_at<=snapshot_at AND(app.comment_deadline(c.id) IS NULL OR app.comment_deadline(c.id)>statement_timestamp())
 UNION ALL SELECT r.post_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.post_reactions r JOIN app.posts p ON p.id=r.post_id WHERE section='post_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(p.expires_at,(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT r.comment_id::text||':'||r.reaction_tag,to_jsonb(r)||jsonb_build_object('effective_expires_at',least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)) FROM app.comment_reactions r WHERE section='comment_reactions' AND r.member_id=app.actor() AND r.created_at<=snapshot_at AND(least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz) IS NULL OR least(app.comment_deadline(r.comment_id),(r.envelope->'context'->>'expiresAt')::timestamptz)>statement_timestamp())
 UNION ALL SELECT m.id::text,(to_jsonb(m)-'object_key')||jsonb_build_object('effective_expires_at',app.media_deadline(m.id)) FROM app.media_assets m WHERE section='media' AND m.owner_id=app.actor() AND m.state IN('ready','attached') AND m.created_at<=snapshot_at AND(app.media_deadline(m.id) IS NULL OR app.media_deadline(m.id)>statement_timestamp())
 UNION ALL SELECT (CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END)::text,jsonb_build_object('member_id',CASE WHEN c.member_a=app.actor() THEN c.member_b ELSE c.member_a END,'kind',CASE WHEN c.member_a=app.actor() THEN c.kind_a ELSE c.kind_b END) FROM app.connections c WHERE section='connections' AND app.actor() IN(c.member_a,c.member_b) AND c.accepted_at<=snapshot_at
 UNION ALL SELECT g.group_id::text,jsonb_build_object('group_id',g.group_id,'role',g.role) FROM app.group_memberships g WHERE section='groups' AND g.member_id=app.actor() AND g.joined_at<=snapshot_at
 ) owned(export_id,item) WHERE CASE WHEN exact_id IS NULL THEN owned.export_id>after_id ELSE owned.export_id=exact_id END
 ORDER BY owned.export_id LIMIT least(greatest(take_count,1),26)
$$;

CREATE FUNCTION app.child_identity_once() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF EXISTS(SELECT FROM app.deletion_ledger WHERE kind='child_profiles' AND object_id=NEW.id) THEN RAISE EXCEPTION 'CONTENT_DELETED';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER child_identity_once BEFORE INSERT ON app.child_profiles FOR EACH ROW EXECUTE FUNCTION app.child_identity_once();
REVOKE ALL ON FUNCTION app.child_identity_once() FROM PUBLIC;
