-- Every interactive content transaction takes the audience lock before parent
-- row locks, matching group deletion and membership changes. This avoids a
-- group-deletion versus comment/reaction deadlock.
CREATE OR REPLACE FUNCTION app.lock_post(p uuid) RETURNS SETOF app.posts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 PERFORM app.lock_epoch();
 IF NOT app.can_post(p) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN QUERY SELECT * FROM app.posts WHERE id=p FOR UPDATE;
END $$;
CREATE OR REPLACE FUNCTION app.lock_comment(c uuid) RETURNS SETOF app.comments LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 PERFORM app.lock_epoch();
 IF NOT app.can_comment(c) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 RETURN QUERY SELECT * FROM app.comments WHERE id=c FOR UPDATE;
END $$;
