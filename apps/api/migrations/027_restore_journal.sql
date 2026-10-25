-- Independent R2 checkpoints mirror these minimal safety decisions, not bodies.
CREATE TABLE app.safety_journal_state (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), generation uuid NOT NULL DEFAULT gen_random_uuid(),
 sequence bigint NOT NULL DEFAULT 0, restore_quarantined boolean NOT NULL DEFAULT false
);
INSERT INTO app.safety_journal_state(id) VALUES(true);
CREATE TABLE app.safety_journal (
 sequence bigint PRIMARY KEY, id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 occurred_at timestamptz NOT NULL DEFAULT now(), decision jsonb NOT NULL
);
ALTER TABLE app.safety_journal_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.safety_journal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.safety_journal_state,app.safety_journal FROM PUBLIC;

CREATE FUNCTION app.append_safety_decision(value jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE n bigint;
BEGIN
 -- Only a migration/restore identity with schema CREATE may suppress capture.
 IF current_setting('app.restore_replay',true)='on' AND has_schema_privilege(session_user,'app','CREATE') THEN RETURN; END IF;
 -- A transactional counter serializes event allocation through commit: no
 -- sequence gaps from rollbacks and no late commits behind a published cursor.
 UPDATE app.safety_journal_state SET sequence=sequence+1 WHERE id RETURNING sequence INTO n;
 INSERT INTO app.safety_journal(sequence,decision) VALUES(n,value);
END $$;

CREATE FUNCTION app.capture_safety_decision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,public AS $$
BEGIN
 IF TG_TABLE_NAME='deletion_ledger' THEN
  PERFORM app.append_safety_decision(jsonb_build_object('action','delete','kind',NEW.kind,'id',NEW.object_id));
 ELSIF TG_TABLE_NAME='deletion_outbox' THEN
  PERFORM app.append_safety_decision(jsonb_build_object('action','media_object','key',NEW.object_key));
 ELSIF TG_TABLE_NAME IN('posts','comments') THEN
  IF NEW.expires_at IS NOT NULL AND(TG_OP='INSERT' OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
   PERFORM app.append_safety_decision(jsonb_build_object('action','deadline','kind',TG_TABLE_NAME,'id',NEW.id,'expires_at',NEW.expires_at));
  END IF;
  IF TG_OP='UPDATE' AND NEW.envelope IS DISTINCT FROM OLD.envelope THEN
   PERFORM app.append_safety_decision(jsonb_build_object('action','revision','kind',TG_TABLE_NAME,'id',NEW.id,'revision',NEW.envelope->'context'->>'revision'));
  END IF;
 ELSIF TG_TABLE_NAME='profiles' THEN
  IF NEW.envelope IS DISTINCT FROM OLD.envelope THEN PERFORM app.append_safety_decision(jsonb_build_object('action','revision','kind','profiles','id',NEW.member_id,'revision',NEW.envelope->'context'->>'revision'));END IF;
 ELSIF TG_TABLE_NAME IN('post_reactions','comment_reactions') THEN
  PERFORM app.append_safety_decision(jsonb_build_object('action','reaction','kind',TG_TABLE_NAME,'target',CASE WHEN TG_TABLE_NAME='post_reactions' THEN to_jsonb(OLD)->>'post_id' ELSE to_jsonb(OLD)->>'comment_id' END,'member',OLD.member_id,'tag',OLD.reaction_tag));
 ELSIF TG_TABLE_NAME='connections' THEN
  IF TG_OP='DELETE' OR(OLD.kind='family' AND NEW.kind<>'family') THEN
   PERFORM app.append_safety_decision(jsonb_build_object('action','connection','a',OLD.member_a,'b',OLD.member_b));
  END IF;
 ELSIF TG_TABLE_NAME='group_memberships' THEN
  IF TG_OP='DELETE' THEN PERFORM app.append_safety_decision(jsonb_build_object('action','membership','group',OLD.group_id,'member',OLD.member_id));
  ELSE PERFORM app.append_safety_decision(jsonb_build_object('action','group_role','group',NEW.group_id,'member',NEW.member_id,'role',NEW.role)); END IF;
 ELSIF TG_TABLE_NAME='groups' THEN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN PERFORM app.append_safety_decision(jsonb_build_object('action','group_owner','id',NEW.id,'owner',NEW.owner_id));END IF;
  IF NEW.envelope IS DISTINCT FROM OLD.envelope THEN PERFORM app.append_safety_decision(jsonb_build_object('action','revision','kind','groups','id',NEW.id,'revision',NEW.envelope->'context'->>'revision'));END IF;
 ELSIF TG_TABLE_NAME='post_recipients' THEN
  PERFORM app.append_safety_decision(jsonb_build_object('action','recipient','post',OLD.post_id,'device',OLD.device_id));
 ELSIF TG_TABLE_NAME='blocks' THEN
  PERFORM app.append_safety_decision(jsonb_build_object('action','block','actor',NEW.actor,'target',NEW.target));
 ELSIF TG_TABLE_NAME='device_keys' THEN
  IF TG_OP='DELETE' OR(NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL) THEN
   PERFORM app.append_safety_decision(jsonb_build_object('action','device','id',OLD.id));
  END IF;
 ELSIF TG_TABLE_NAME='members' THEN
  IF NEW.status IS DISTINCT FROM OLD.status THEN PERFORM app.append_safety_decision(jsonb_build_object('action','status','id',NEW.id,'status',NEW.status)); END IF;
 ELSIF TG_TABLE_NAME='auth_user' THEN
  IF TG_OP='DELETE' THEN PERFORM app.append_safety_decision(jsonb_build_object('action','identity','id',OLD.id));
  ELSIF NEW.email IS DISTINCT FROM OLD.email OR NEW.credentials_changed_at IS DISTINCT FROM OLD.credentials_changed_at THEN
   PERFORM app.append_safety_decision(jsonb_build_object('action','security_hold','id',NEW.id));
  END IF;
 ELSIF TG_TABLE_NAME='auth_two_factor' THEN
  IF TG_OP='DELETE' THEN PERFORM app.append_safety_decision(jsonb_build_object('action','security_hold','id',OLD."userId"));
  ELSE PERFORM app.append_safety_decision(jsonb_build_object('action','security_hold','id',NEW."userId"));END IF;
 ELSIF TG_TABLE_NAME='encrypted_key_backups' THEN
  IF NEW.envelope->'recovery' IS DISTINCT FROM OLD.envelope->'recovery' OR EXISTS(
   SELECT FROM jsonb_array_elements(OLD.envelope->'devices') old_key WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(NEW.envelope->'devices') new_key WHERE new_key=old_key)
  ) THEN PERFORM app.append_safety_decision(jsonb_build_object('action','key_backup','id',NEW.member_id));END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE TRIGGER journal_deleted AFTER INSERT ON app.deletion_ledger FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_media_object AFTER INSERT ON app.deletion_outbox FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_post_deadline AFTER INSERT OR UPDATE OF expires_at,envelope ON app.posts FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_comment_deadline AFTER INSERT OR UPDATE OF expires_at,envelope ON app.comments FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_profile_revision AFTER UPDATE OF envelope ON app.profiles FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_post_reaction AFTER DELETE ON app.post_reactions FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_comment_reaction AFTER DELETE ON app.comment_reactions FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_connection AFTER DELETE OR UPDATE OF kind ON app.connections FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_membership AFTER DELETE OR UPDATE OF role ON app.group_memberships FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_group_owner AFTER UPDATE OF owner_id,envelope ON app.groups FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_recipient AFTER DELETE ON app.post_recipients FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_block AFTER INSERT ON app.blocks FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_device AFTER DELETE OR UPDATE OF revoked_at ON app.device_keys FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_status AFTER UPDATE OF status ON app.members FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_identity AFTER DELETE OR UPDATE OF email,credentials_changed_at ON public.auth_user FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_mfa AFTER INSERT OR DELETE OR UPDATE OF secret,"backupCodes" ON public.auth_two_factor FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();
CREATE TRIGGER journal_key_backup AFTER UPDATE OF envelope ON app.encrypted_key_backups FOR EACH ROW EXECUTE FUNCTION app.capture_safety_decision();

CREATE FUNCTION app.safety_status() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT jsonb_build_object('generation',generation,'sequence',sequence::text,'quarantined',restore_quarantined) FROM app.safety_journal_state WHERE id
$$;
CREATE FUNCTION app.safety_page(after_sequence bigint,batch_size integer DEFAULT 200) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('sequence',sequence::text,'id',id,'occurred_at',occurred_at,'decision',decision) ORDER BY sequence),'[]'::jsonb)
 FROM(SELECT * FROM app.safety_journal WHERE sequence>after_sequence ORDER BY sequence LIMIT least(greatest(batch_size,1),500)) rows
$$;
REVOKE ALL ON FUNCTION app.append_safety_decision(jsonb),app.capture_safety_decision(),app.safety_status(),app.safety_page(bigint,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.safety_status(),app.safety_page(bigint,integer) TO porchday_jobs;

-- Owner-only replay. No runtime role can invoke this or clear quarantine.
CREATE FUNCTION app.replay_safety_batch(events jsonb) RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,app,public AS $$
DECLARE event jsonb;d jsonb;n integer:=0;kind text;object uuid;
BEGIN
 IF NOT has_schema_privilege(session_user,'app','CREATE') OR NOT EXISTS(SELECT FROM app.safety_journal_state WHERE id AND restore_quarantined) THEN RAISE EXCEPTION 'RESTORE_QUARANTINE_REQUIRED'; END IF;
 IF jsonb_typeof(events)<>'array' OR jsonb_array_length(events)>500 THEN RAISE EXCEPTION 'INVALID_JOURNAL'; END IF;
 PERFORM set_config('app.restore_replay','on',true);
 FOR event IN SELECT value FROM jsonb_array_elements(events) LOOP
  d:=event->'decision';kind:=d->>'kind';
  CASE d->>'action'
  WHEN 'delete' THEN
   object:=(d->>'id')::uuid;
   IF kind='members' THEN
    -- A replayed member deletion must not leave a restored owned group behind.
    DELETE FROM app.groups WHERE owner_id=object;DELETE FROM app.members WHERE id=object;
    DELETE FROM public.auth_user WHERE id=object::text;
   ELSIF kind IN('posts','comments','groups','media_assets') THEN EXECUTE format('DELETE FROM app.%I WHERE id=$1',kind) USING object;
   ELSE RAISE EXCEPTION 'INVALID_JOURNAL_KIND'; END IF;
   INSERT INTO app.deletion_ledger(kind,object_id) VALUES(kind,object) ON CONFLICT DO NOTHING;
  WHEN 'deadline' THEN
   IF kind NOT IN('posts','comments') THEN RAISE EXCEPTION 'INVALID_JOURNAL_KIND'; END IF;
   EXECUTE format('UPDATE app.%I SET expires_at=least(expires_at,$1) WHERE id=$2 AND(expires_at IS NULL OR expires_at>$1)',kind) USING(d->>'expires_at')::timestamptz,(d->>'id')::uuid;
  WHEN 'revision' THEN
   IF(d->>'revision')::integer<1 THEN RAISE EXCEPTION 'INVALID_JOURNAL_REVISION'; END IF;
   IF kind IN('posts','comments') THEN
    EXECUTE format('DELETE FROM app.%I WHERE id=$1 AND coalesce((envelope->''context''->>''revision'')::integer,0)<$2',kind) USING(d->>'id')::uuid,(d->>'revision')::integer;
   ELSIF kind='profiles' THEN UPDATE app.profiles SET envelope=NULL WHERE member_id=(d->>'id')::uuid AND coalesce((envelope->'context'->>'revision')::integer,0)<(d->>'revision')::integer;
   ELSIF kind='groups' THEN UPDATE app.groups SET envelope='{}' WHERE id=(d->>'id')::uuid AND coalesce((envelope->'context'->>'revision')::integer,0)<(d->>'revision')::integer;
   ELSE RAISE EXCEPTION 'INVALID_JOURNAL_KIND'; END IF;
  WHEN 'media_object' THEN
   IF d->>'key' !~ '^media/' OR length(d->>'key')>1024 THEN RAISE EXCEPTION 'INVALID_JOURNAL_KEY'; END IF;
   INSERT INTO app.deletion_outbox(object_key,reason) VALUES(d->>'key','restore_reconciliation') ON CONFLICT(object_key) DO UPDATE SET completed_at=NULL,next_retry=now();
  WHEN 'reaction' THEN
   IF kind NOT IN('post_reactions','comment_reactions') THEN RAISE EXCEPTION 'INVALID_JOURNAL_KIND'; END IF;
   EXECUTE format('DELETE FROM app.%I WHERE %I=$1 AND member_id=$2 AND reaction_tag=$3',kind,CASE WHEN kind='post_reactions' THEN 'post_id' ELSE 'comment_id' END) USING(d->>'target')::uuid,(d->>'member')::uuid,d->>'tag';
  WHEN 'connection' THEN DELETE FROM app.connections WHERE member_a=(d->>'a')::uuid AND member_b=(d->>'b')::uuid;
  WHEN 'membership' THEN DELETE FROM app.group_memberships WHERE group_id=(d->>'group')::uuid AND member_id=(d->>'member')::uuid;
  WHEN 'group_owner' THEN
   IF EXISTS(SELECT FROM app.groups WHERE id=(d->>'id')::uuid) AND NOT EXISTS(SELECT FROM app.members WHERE id=(d->>'owner')::uuid) THEN RAISE EXCEPTION 'RESTORE_OWNER_MISSING'; END IF;
   UPDATE app.groups SET owner_id=(d->>'owner')::uuid WHERE id=(d->>'id')::uuid;
  WHEN 'group_role' THEN UPDATE app.group_memberships SET role=d->>'role' WHERE group_id=(d->>'group')::uuid AND member_id=(d->>'member')::uuid;
  WHEN 'recipient' THEN DELETE FROM app.post_recipients WHERE post_id=(d->>'post')::uuid AND device_id=(d->>'device')::uuid;
  WHEN 'block' THEN
   IF EXISTS(SELECT FROM app.members WHERE id=(d->>'actor')::uuid) AND EXISTS(SELECT FROM app.members WHERE id=(d->>'target')::uuid) THEN INSERT INTO app.blocks(actor,target) VALUES((d->>'actor')::uuid,(d->>'target')::uuid) ON CONFLICT DO NOTHING; END IF;
  WHEN 'device' THEN UPDATE app.device_keys SET revoked_at=coalesce(revoked_at,now()) WHERE id=(d->>'id')::uuid;
  WHEN 'status' THEN UPDATE app.members SET status=d->>'status' WHERE id=(d->>'id')::uuid;
  WHEN 'security_hold' THEN PERFORM app.set_security_hold((d->>'id')::uuid);
  WHEN 'identity' THEN DELETE FROM public.auth_user WHERE id=d->>'id';
  WHEN 'key_backup' THEN DELETE FROM app.encrypted_key_backups WHERE member_id=(d->>'id')::uuid;
  ELSE RAISE EXCEPTION 'INVALID_JOURNAL_ACTION';
  END CASE;
  INSERT INTO app.safety_journal(sequence,id,occurred_at,decision) VALUES((event->>'sequence')::bigint,(event->>'id')::uuid,(event->>'occurred_at')::timestamptz,d) ON CONFLICT(sequence) DO UPDATE SET id=excluded.id,occurred_at=excluded.occurred_at,decision=excluded.decision;
  n:=n+1;
 END LOOP;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.replay_safety_batch(jsonb) FROM PUBLIC;

-- Restore may remove unavailable stale ciphertext; it cannot manufacture a new
-- signed revision. Ordinary runtime updates retain the monotonic signature rule.
CREATE OR REPLACE FUNCTION app.monotonic_envelope_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,app AS $$ BEGIN
 IF current_setting('app.restore_replay',true)='on' AND has_schema_privilege(session_user,'app','CREATE') THEN RETURN NEW; END IF;
 IF NEW.envelope IS DISTINCT FROM OLD.envelope AND(NEW.envelope->'context'->>'revision')::integer IS DISTINCT FROM coalesce((OLD.envelope->'context'->>'revision')::integer,0)+1 THEN RAISE EXCEPTION 'REVISION_CHANGED'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.bind_group_author() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF current_setting('app.restore_replay',true)='on' AND has_schema_privilege(session_user,'app','CREATE') AND NEW.envelope='{}'::jsonb THEN NEW.author_key:=NULL;RETURN NEW;END IF;
 SELECT jsonb_build_object('id',d.id,'member_id',d.member_id,'public_key',d.public_key,'fingerprint',d.fingerprint) INTO NEW.author_key FROM app.device_keys d WHERE d.id=(NEW.envelope->'context'->>'authorDeviceId')::uuid AND d.member_id=(NEW.envelope->'context'->>'authorId')::uuid AND d.revoked_at IS NULL;
 IF NEW.author_key IS NULL THEN RAISE EXCEPTION 'GROUP_AUTHOR_KEY_REQUIRED'; END IF;
 RETURN NEW;
END $$;

-- Bootstrap the known historical decisions and existing deadlines before the
-- operator initializes the first external checkpoint. No retention pruning yet.
DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT kind,object_id FROM app.deletion_ledger LOOP PERFORM app.append_safety_decision(jsonb_build_object('action','delete','kind',r.kind,'id',r.object_id));END LOOP;
 FOR r IN SELECT object_key FROM app.deletion_outbox LOOP PERFORM app.append_safety_decision(jsonb_build_object('action','media_object','key',r.object_key));END LOOP;
 FOR r IN SELECT 'posts'::text kind,id,expires_at FROM app.posts WHERE expires_at IS NOT NULL UNION ALL SELECT 'comments',id,expires_at FROM app.comments WHERE expires_at IS NOT NULL LOOP PERFORM app.append_safety_decision(jsonb_build_object('action','deadline','kind',r.kind,'id',r.id,'expires_at',r.expires_at));END LOOP;
END $$;
