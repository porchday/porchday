-- PlanetScale's default postgres login survives a PITR even when a restored
-- managed owner's credential cannot be reset. It already has provider-level
-- pg_read_all_data/pg_write_all_data and BYPASSRLS. Give that administrator only
-- the extra schema/function rights required by the reviewed restore commands;
-- do not reassign any table, trigger, SECURITY DEFINER function or schema owner.
GRANT USAGE, CREATE ON SCHEMA app TO postgres;
GRANT EXECUTE ON FUNCTION
 app.safety_status(),
 app.safety_page(bigint,integer),
 app.replay_safety_batch(jsonb),
 app.set_security_hold(uuid),
 app.expire_batch(integer),
 app.comment_deadline(uuid),
 app.media_deadline(uuid)
TO postgres;

-- The recovery administrator can attach replacement provider-managed login
-- credentials to these existing groups. Administration grants do not confer
-- inherited permissions or permit SET ROLE into any runtime group.
GRANT porchday_auth, porchday_social, porchday_jobs TO postgres
 WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
