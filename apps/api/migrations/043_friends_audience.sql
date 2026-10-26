-- Friends-only is a distinct audience. Existing connections posts continue to
-- include both relationship kinds; signed envelopes are never relabeled.
ALTER TABLE app.posts DROP CONSTRAINT posts_audience_check;
ALTER TABLE app.posts ADD CONSTRAINT posts_audience_check
 CHECK(audience IN('connections','friends','family','only_me','group'));

CREATE FUNCTION app.friends(a uuid,b uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT FROM app.connections
  WHERE member_a=least(a,b) AND member_b=greatest(a,b) AND kind='friend')
  AND NOT app.blocked(a,b)
$$;
REVOKE ALL ON FUNCTION app.friends(uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.can_post(p uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.may_read() AND EXISTS(
  SELECT FROM app.posts p0 WHERE p0.id=p
   AND(p0.expires_at IS NULL OR p0.expires_at>statement_timestamp())
   AND NOT app.blocked(p0.author_id,app.actor())
   AND(p0.group_id IS NULL OR app.in_group(p0.group_id,app.actor()))
   AND(p0.author_id=app.actor() OR(
    EXISTS(SELECT FROM app.post_recipients r WHERE r.post_id=p AND r.member_id=app.actor())
    AND((p0.audience='connections' AND app.connected(p0.author_id,app.actor()))
     OR(p0.audience='friends' AND app.friends(p0.author_id,app.actor()))
     OR(p0.audience='family' AND app.connected(p0.author_id,app.actor(),true))
     OR(p0.audience='group' AND app.in_group(p0.group_id,app.actor()))))))
$$;

CREATE OR REPLACE FUNCTION app.audience_members(audience text,g uuid DEFAULT NULL,p uuid DEFAULT NULL)
RETURNS TABLE(member_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF p IS NOT NULL AND NOT app.can_post(p) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF audience='group' AND NOT app.in_group(g,app.actor()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 RETURN QUERY SELECT m.id FROM app.members m
 WHERE m.status IN('active','restricted') AND NOT app.blocked(m.id,app.actor()) AND(
  CASE WHEN p IS NOT NULL THEN EXISTS(
   SELECT FROM app.posts p0 WHERE p0.id=p AND NOT app.blocked(m.id,p0.author_id)
    AND(m.id=p0.author_id OR(
     EXISTS(SELECT FROM app.post_recipients pr WHERE pr.post_id=p AND pr.member_id=m.id)
     AND((p0.audience='connections' AND app.connected(p0.author_id,m.id))
      OR(p0.audience='friends' AND app.friends(p0.author_id,m.id))
      OR(p0.audience='family' AND app.connected(p0.author_id,m.id,true))
      OR(p0.audience='group' AND app.in_group(p0.group_id,m.id))))))
  ELSE m.id=app.actor()
   OR(audience='connections' AND app.connected(app.actor(),m.id))
   OR(audience='friends' AND app.friends(app.actor(),m.id))
   OR(audience='family' AND app.connected(app.actor(),m.id,true))
   OR(audience='group' AND app.in_group(g,m.id)) END
 ) ORDER BY m.id;
END $$;
-- A kind change removes historical grants for the kind being left in both
-- directions. Switching back permits future posts, never revives old grants.
-- The original trigger name is retained so each change runs exactly once.
CREATE OR REPLACE FUNCTION app.revoke_family_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF OLD.kind IS DISTINCT FROM NEW.kind THEN
  DELETE FROM app.post_recipients r USING app.posts p
  WHERE r.post_id=p.id
   AND p.audience=CASE OLD.kind WHEN 'friend' THEN 'friends' WHEN 'family' THEN 'family' END
   AND((p.author_id=OLD.member_a AND r.member_id=OLD.member_b)
    OR(p.author_id=OLD.member_b AND r.member_id=OLD.member_a));
 END IF;
 RETURN NEW;
END $$;

-- Restore replay must not reinstate an older relationship classification.
-- Keep every other safety decision and its existing replay format unchanged.
CREATE OR REPLACE FUNCTION app.capture_safety_decision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,public AS $$
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
  IF TG_OP='DELETE' OR OLD.kind IS DISTINCT FROM NEW.kind THEN
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
REVOKE ALL ON FUNCTION app.capture_safety_decision() FROM PUBLIC;
