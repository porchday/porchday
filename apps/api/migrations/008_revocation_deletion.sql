-- Losing a relationship removes historical recipient grants permanently. Reconnecting
-- starts a future-only audience rather than reviving access to old ciphertext.
CREATE FUNCTION app.revoke_connection_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 DELETE FROM app.post_recipients r USING app.posts p WHERE r.post_id=p.id AND p.group_id IS NULL AND((p.author_id=OLD.member_a AND r.member_id=OLD.member_b) OR(p.author_id=OLD.member_b AND r.member_id=OLD.member_a));
 RETURN OLD;
END $$;
CREATE TRIGGER revoke_connection_history BEFORE DELETE ON app.connections FOR EACH ROW EXECUTE FUNCTION app.revoke_connection_history();
CREATE FUNCTION app.revoke_group_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 DELETE FROM app.post_recipients r USING app.posts p WHERE r.post_id=p.id AND p.group_id=OLD.group_id AND r.member_id=OLD.member_id;
 RETURN OLD;
END $$;
CREATE TRIGGER revoke_group_history BEFORE DELETE ON app.group_memberships FOR EACH ROW EXECUTE FUNCTION app.revoke_group_history();
CREATE FUNCTION app.revoke_block_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 DELETE FROM app.post_recipients r USING app.posts p WHERE r.post_id=p.id AND((p.author_id=NEW.actor AND r.member_id=NEW.target) OR(p.author_id=NEW.target AND r.member_id=NEW.actor));
 RETURN NEW;
END $$;
CREATE TRIGGER revoke_block_history AFTER INSERT ON app.blocks FOR EACH ROW EXECUTE FUNCTION app.revoke_block_history();
CREATE TABLE app.identity_deletion_outbox (
 member_id uuid PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz
);
ALTER TABLE app.identity_deletion_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_jobs ON app.identity_deletion_outbox TO porchday_jobs USING(true) WITH CHECK(true);
GRANT SELECT,UPDATE ON app.identity_deletion_outbox TO porchday_jobs;
CREATE FUNCTION app.enqueue_identity_deletion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 INSERT INTO app.identity_deletion_outbox(member_id) VALUES(OLD.id) ON CONFLICT DO NOTHING;
 RETURN OLD;
END $$;
CREATE TRIGGER identity_deletion AFTER DELETE ON app.members FOR EACH ROW EXECUTE FUNCTION app.enqueue_identity_deletion();
CREATE OR REPLACE FUNCTION app.auth_provision_member(member uuid,new_handle text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF EXISTS(SELECT FROM app.deletion_ledger WHERE kind='members' AND object_id=member) THEN RAISE EXCEPTION 'ACCOUNT_DELETED'; END IF;
 INSERT INTO app.members(id,adult_attested_at,rules_accepted_at) VALUES(member,now(),now()) ON CONFLICT DO NOTHING;
 INSERT INTO app.profiles(member_id,handle) VALUES(member,new_handle) ON CONFLICT(member_id) DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION app.can_delete_post(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT app.may_read() AND EXISTS(SELECT FROM app.posts WHERE id=p AND(author_id=app.actor() OR(app.may_write() AND app.group_manager(group_id,app.actor())))) $$;
CREATE OR REPLACE FUNCTION app.can_delete_comment(c uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT app.may_read() AND EXISTS(SELECT FROM app.comments c0 JOIN app.posts p ON p.id=c0.post_id WHERE c0.id=c AND(c0.author_id=app.actor() OR(app.may_write() AND(p.author_id=app.actor() OR app.group_manager(p.group_id,app.actor()))))) $$;
REVOKE ALL ON FUNCTION app.revoke_connection_history(),app.revoke_group_history(),app.revoke_block_history(),app.enqueue_identity_deletion() FROM PUBLIC;
