-- SELECT ... FOR SHARE/UPDATE also uses UPDATE RLS policies. Encapsulate locks
-- instead of granting friends write access merely to serialize their comments.
CREATE FUNCTION app.lock_epoch() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE result bigint; BEGIN
 IF NOT app.may_read() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT epoch INTO result FROM app.directory_epoch WHERE id FOR SHARE;
 RETURN result;
END $$;
CREATE FUNCTION app.lock_post(p uuid) RETURNS SETOF app.posts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NOT app.can_post(p) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN QUERY SELECT * FROM app.posts WHERE id=p FOR UPDATE;
END $$;
CREATE FUNCTION app.lock_comment(c uuid) RETURNS SETOF app.comments LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 IF NOT app.can_comment(c) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN QUERY SELECT * FROM app.comments WHERE id=c FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION app.lock_epoch(),app.lock_post(uuid),app.lock_comment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_epoch(),app.lock_post(uuid),app.lock_comment(uuid) TO porchday_social;
REVOKE UPDATE(epoch) ON app.directory_epoch FROM porchday_social;
