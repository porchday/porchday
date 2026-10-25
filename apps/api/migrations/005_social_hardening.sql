-- Defense in depth for child invariants even when a future HTTP route is wrong.
CREATE FUNCTION app.check_comment_lifecycle() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE deadline timestamptz; depth integer; p app.posts;
BEGIN
 SELECT * INTO p FROM app.posts WHERE id=NEW.post_id FOR UPDATE;
 IF p.id IS NULL OR(p.expires_at IS NOT NULL AND p.expires_at<=statement_timestamp()) THEN RAISE EXCEPTION 'PARENT_EXPIRED'; END IF;
 deadline:=p.expires_at;
 IF NEW.parent_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT FROM app.comments WHERE id=NEW.parent_id AND post_id=NEW.post_id) THEN RAISE EXCEPTION 'INVALID_PARENT'; END IF;
  deadline:=least(deadline,app.comment_deadline(NEW.parent_id));
  WITH RECURSIVE chain AS(SELECT id,parent_id FROM app.comments WHERE id=NEW.parent_id UNION ALL SELECT c.id,c.parent_id FROM app.comments c JOIN chain ON chain.parent_id=c.id) SELECT count(*) INTO depth FROM chain;
  IF depth>=64 THEN RAISE EXCEPTION 'THREAD_DEPTH_LIMIT'; END IF;
 END IF;
 IF deadline IS NOT NULL AND(deadline<=statement_timestamp() OR NEW.expires_at IS NULL OR NEW.expires_at>deadline) THEN RAISE EXCEPTION 'INHERITED_DEADLINE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER comment_lifecycle BEFORE INSERT ON app.comments FOR EACH ROW EXECUTE FUNCTION app.check_comment_lifecycle();
CREATE POLICY invitations_update ON app.group_invitations FOR UPDATE USING(app.may_write() AND app.group_manager(group_id,app.actor())) WITH CHECK(app.may_write() AND app.group_manager(group_id,app.actor()));
GRANT UPDATE(id,expires_at,accepted_at,envelope) ON app.group_invitations TO porchday_social;
-- Keep former recipients from downloading a post they authored in a group they left,
-- while authored exports remain accessible through the explicitly own-data function.
CREATE OR REPLACE FUNCTION app.can_post(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.may_read() AND EXISTS(SELECT FROM app.posts p0 WHERE p0.id=p AND (p0.expires_at IS NULL OR p0.expires_at>statement_timestamp()) AND NOT app.blocked(p0.author_id,app.actor()) AND (p0.group_id IS NULL OR app.in_group(p0.group_id,app.actor())) AND (
 p0.author_id=app.actor() OR (EXISTS(SELECT FROM app.post_recipients r WHERE r.post_id=p AND r.member_id=app.actor()) AND (
 (p0.audience='connections' AND app.connected(p0.author_id,app.actor())) OR
 (p0.audience='family' AND app.connected(p0.author_id,app.actor(),true)) OR
 (p0.audience='group' AND app.in_group(p0.group_id,app.actor()))))))
$$;
REVOKE ALL ON FUNCTION app.check_comment_lifecycle() FROM PUBLIC;
