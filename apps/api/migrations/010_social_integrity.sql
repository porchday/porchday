CREATE FUNCTION app.prevent_resurrection() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF EXISTS(SELECT FROM app.deletion_ledger WHERE kind=TG_TABLE_NAME AND object_id=NEW.id) THEN RAISE EXCEPTION 'CONTENT_DELETED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER post_no_resurrection BEFORE INSERT ON app.posts FOR EACH ROW EXECUTE FUNCTION app.prevent_resurrection();
CREATE TRIGGER comment_no_resurrection BEFORE INSERT ON app.comments FOR EACH ROW EXECUTE FUNCTION app.prevent_resurrection();
CREATE TRIGGER media_no_resurrection BEFORE INSERT ON app.media_assets FOR EACH ROW EXECUTE FUNCTION app.prevent_resurrection();
CREATE TRIGGER group_no_resurrection BEFORE INSERT ON app.groups FOR EACH ROW EXECUTE FUNCTION app.prevent_resurrection();
CREATE FUNCTION app.record_group_deletion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 INSERT INTO app.deletion_ledger(kind,object_id) VALUES('groups',OLD.id) ON CONFLICT DO NOTHING;RETURN OLD;
END $$;
CREATE TRIGGER group_deletion BEFORE DELETE ON app.groups FOR EACH ROW EXECUTE FUNCTION app.record_group_deletion();
CREATE OR REPLACE FUNCTION app.member_handles(ids uuid[]) RETURNS TABLE(id uuid,handle text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT p.member_id,p.handle FROM app.profiles p WHERE p.member_id=ANY(ids) AND app.may_read() AND NOT app.blocked(p.member_id,app.actor()) AND(p.member_id=app.actor() OR app.connected(p.member_id,app.actor()) OR EXISTS(SELECT FROM app.group_memberships a JOIN app.group_memberships b USING(group_id) WHERE a.member_id=app.actor() AND b.member_id=p.member_id) OR EXISTS(SELECT FROM app.connection_requests WHERE app.actor() IN(sender,recipient) AND p.member_id IN(sender,recipient)) OR EXISTS(SELECT FROM app.comments c WHERE c.author_id=p.member_id AND app.can_comment(c.id)))
$$;
CREATE FUNCTION app.export_media(job uuid,media uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE result text;BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN';END IF;
 IF NOT EXISTS(SELECT FROM app.data_transfer_jobs WHERE id=job AND member_id=app.actor() AND kind='export' AND state='complete' AND expires_at>now()) THEN RAISE EXCEPTION 'EXPORT_INVALIDATED';END IF;
 SELECT m.object_key INTO result FROM app.media_assets m LEFT JOIN app.posts p ON p.id=m.post_id WHERE m.id=media AND m.owner_id=app.actor() AND m.state IN('ready','attached') AND(p.expires_at IS NULL OR p.expires_at>now());
 IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;RETURN result;
END $$;
CREATE TABLE app.social_rate_limits(member_id uuid NOT NULL REFERENCES app.members ON DELETE CASCADE,bucket bigint NOT NULL,count integer NOT NULL,PRIMARY KEY(member_id,bucket));
ALTER TABLE app.social_rate_limits ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION app.allow_social_request() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE n integer;b bigint:=floor(extract(epoch from now())/60);BEGIN
 IF NOT app.may_read() THEN RETURN false;END IF;
 INSERT INTO app.social_rate_limits(member_id,bucket,count) VALUES(app.actor(),b,1) ON CONFLICT(member_id,bucket) DO UPDATE SET count=social_rate_limits.count+1 RETURNING count INTO n;
 DELETE FROM app.social_rate_limits WHERE member_id=app.actor() AND bucket<b-2;
 RETURN n<=120;
END $$;
REVOKE ALL ON FUNCTION app.prevent_resurrection(),app.record_group_deletion(),app.export_media(uuid,uuid),app.allow_social_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.export_media(uuid,uuid),app.allow_social_request() TO porchday_social;
