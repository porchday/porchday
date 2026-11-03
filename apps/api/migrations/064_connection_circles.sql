-- Circles include self and direct connections; extended family requires mutual
-- family labels on every edge. Paths are at most two hops and expose no bridge.
CREATE FUNCTION app.in_circle(a uuid,b uuid,family_only boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT NOT app.blocked(a,b) AND EXISTS(SELECT FROM app.members WHERE id=a AND status IN('active','restricted'))
 AND EXISTS(SELECT FROM app.members WHERE id=b AND status IN('active','restricted')) AND(a=b OR
 EXISTS(SELECT FROM app.connections c WHERE c.member_a=least(a,b) AND c.member_b=greatest(a,b) AND(NOT family_only OR(c.kind_a='family' AND c.kind_b='family')))
 OR EXISTS(SELECT FROM app.connections first JOIN app.connections second ON
  (CASE WHEN first.member_a=a THEN first.member_b ELSE first.member_a END) IN(second.member_a,second.member_b)
 JOIN app.members bridge ON bridge.id=CASE WHEN first.member_a=a THEN first.member_b ELSE first.member_a END
 WHERE a IN(first.member_a,first.member_b) AND b IN(second.member_a,second.member_b)
 AND bridge.status IN('active','restricted') AND NOT app.blocked(a,bridge.id) AND NOT app.blocked(bridge.id,b)
 AND(NOT family_only OR(first.kind_a='family' AND first.kind_b='family' AND second.kind_a='family' AND second.kind_b='family'))))
$$;
CREATE FUNCTION app.circle_member_ids(a uuid,family_only boolean DEFAULT false) RETURNS TABLE(member_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 WITH direct AS MATERIALIZED (
 SELECT CASE WHEN c.member_a=a THEN c.member_b ELSE c.member_a END AS id FROM app.connections c
 JOIN app.members m ON m.id=CASE WHEN c.member_a=a THEN c.member_b ELSE c.member_a END
 WHERE a IN(c.member_a,c.member_b) AND m.status IN('active','restricted') AND NOT app.blocked(a,m.id)
 AND(NOT family_only OR(c.kind_a='family' AND c.kind_b='family'))
 ), candidates AS (
 SELECT a AS id UNION SELECT id FROM direct UNION
 SELECT CASE WHEN c.member_a=d.id THEN c.member_b ELSE c.member_a END FROM direct d JOIN app.connections c ON d.id IN(c.member_a,c.member_b)
 WHERE NOT app.blocked(c.member_a,c.member_b) AND(NOT family_only OR(c.kind_a='family' AND c.kind_b='family'))
 ) SELECT c.id FROM candidates c JOIN app.members m ON m.id=c.id WHERE m.status IN('active','restricted') AND NOT app.blocked(a,c.id)
$$;
CREATE FUNCTION app.author_category(author uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT CASE WHEN NOT app.may_read() OR app.blocked(app.actor(),author) THEN NULL
 WHEN author=app.actor() THEN 'me'
 WHEN EXISTS(SELECT FROM app.connections c WHERE c.member_a=least(app.actor(),author) AND c.member_b=greatest(app.actor(),author) AND c.kind_a='family' AND c.kind_b='family') THEN 'family'
 WHEN app.connected(app.actor(),author) THEN 'friends'
 WHEN app.in_circle(app.actor(),author,true) THEN 'extended_family'
 WHEN app.in_circle(app.actor(),author,false) THEN 'community' END
$$;
ALTER TABLE app.posts DROP CONSTRAINT posts_audience_check;
ALTER TABLE app.posts ADD CONSTRAINT posts_audience_check CHECK(audience IN('connections','friends','family','only_me','group','extended_family','community'));
ALTER TABLE app.photo_grants DROP CONSTRAINT photo_grants_audience_check;
ALTER TABLE app.photo_grants ADD CONSTRAINT photo_grants_audience_check CHECK(audience IN('only_me','connections','friends','family','album','extended_family','community'));
-- Preserve all installed reader guards; add circle clauses beside the existing
-- friendship clauses, without broadening history or profile visibility.
DO $migration$
DECLARE definition text;signature text;needle text;replacement text;
BEGIN
 FOR signature,needle,replacement IN SELECT * FROM(VALUES
 ('app.can_post(uuid)', 'OR(p0.audience=''friends'' AND app.friends(p0.author_id,app.actor()))', 'OR(p0.audience IN(''community'',''extended_family'') AND app.in_circle(p0.author_id,app.actor(),p0.audience=''extended_family''))'),
 ('app.audience_members(text,uuid,uuid)', 'OR(p0.audience=''friends'' AND app.friends(p0.author_id,m.id))', 'OR(p0.audience IN(''community'',''extended_family'') AND app.in_circle(p0.author_id,m.id,p0.audience=''extended_family''))'),
 ('app.audience_members(text,uuid,uuid)', 'OR(audience=''friends'' AND app.friends(app.actor(),m.id))', 'OR(audience IN(''community'',''extended_family'') AND app.in_circle(app.actor(),m.id,audience=''extended_family''))'),
 ('app.can_photo_grant(uuid)', 'OR(g0.audience=''friends'' AND app.friends(p.owner_id,app.actor()))', 'OR(g0.audience IN(''community'',''extended_family'') AND app.in_circle(p.owner_id,app.actor(),g0.audience=''extended_family''))'),
 ('app.photo_grant_audience_members(uuid)', 'OR(grant_row.audience=''friends'' AND app.friends(photo.owner_id,m.id))', 'OR(grant_row.audience IN(''community'',''extended_family'') AND app.in_circle(photo.owner_id,m.id,grant_row.audience=''extended_family''))')
 ) AS changes(signature,needle,replacement) LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'UNRECOGNIZED_CIRCLE_READER: %',signature;END IF;
  EXECUTE replace(definition,needle,needle||' '||replacement);
 END LOOP;
END $migration$;
CREATE FUNCTION app.revoke_circle_paths(a uuid,b uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE authors uuid[];
BEGIN
 SELECT array_agg(DISTINCT who) INTO authors FROM(SELECT a AS who UNION SELECT b UNION SELECT member_a FROM app.connections WHERE a IN(member_a,member_b) OR b IN(member_a,member_b) UNION SELECT member_b FROM app.connections WHERE a IN(member_a,member_b) OR b IN(member_a,member_b)) affected WHERE who IS NOT NULL;
 DELETE FROM app.post_recipients r USING app.posts p WHERE p.id=r.post_id AND p.author_id=ANY(authors) AND p.audience IN('community','extended_family') AND r.member_id<>p.author_id AND NOT app.in_circle(p.author_id,r.member_id,p.audience='extended_family');
 DELETE FROM app.photo_grant_recipients r USING app.photo_grants g,app.photos p WHERE g.id=r.grant_id AND p.id=g.photo_id AND p.owner_id=ANY(authors) AND g.audience IN('community','extended_family') AND r.member_id<>p.owner_id AND NOT app.in_circle(p.owner_id,r.member_id,g.audience='extended_family');
END $$;
CREATE FUNCTION app.revoke_circle_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF TG_TABLE_NAME='connections' THEN PERFORM app.revoke_circle_paths(OLD.member_a,OLD.member_b);
 ELSIF TG_TABLE_NAME='blocks' THEN PERFORM app.revoke_circle_paths(NEW.actor,NEW.target);
 ELSE IF NEW.status NOT IN('active','restricted') THEN PERFORM app.revoke_circle_paths(NEW.id);END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER revoke_circle_connection AFTER DELETE OR UPDATE OF kind_a,kind_b ON app.connections FOR EACH ROW EXECUTE FUNCTION app.revoke_circle_change();
CREATE TRIGGER revoke_circle_block AFTER INSERT ON app.blocks FOR EACH ROW EXECUTE FUNCTION app.revoke_circle_change();
CREATE TRIGGER revoke_circle_member AFTER UPDATE OF status ON app.members FOR EACH ROW EXECUTE FUNCTION app.revoke_circle_change();
REVOKE ALL ON FUNCTION app.in_circle(uuid,uuid,boolean),app.author_category(uuid),app.revoke_circle_paths(uuid,uuid),app.revoke_circle_change() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.author_category(uuid) TO porchday_social;

DO $migration$
DECLARE definition text;needle text;
BEGIN
 SELECT pg_get_functiondef('app.audience_members(text,uuid,uuid)'::regprocedure) INTO definition;
 needle:='RETURN QUERY SELECT m.id FROM app.members m';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_CIRCLE_AUDIENCE';END IF;
 EXECUTE replace(definition,needle,'IF p IS NULL AND audience IN(''community'',''extended_family'') THEN RETURN QUERY SELECT circle.member_id FROM app.circle_member_ids(app.actor(),audience=''extended_family'') circle ORDER BY circle.member_id; RETURN;END IF; '||needle);
 SELECT pg_get_functiondef('app.member_handles(uuid[])'::regprocedure) INTO definition;
 needle:='OR EXISTS(SELECT FROM app.comments c WHERE';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_HANDLE_READER';END IF;
 EXECUTE replace(definition,needle,'OR EXISTS(SELECT FROM app.posts visible_post WHERE visible_post.author_id=p.member_id AND app.can_post(visible_post.id)) OR EXISTS(SELECT FROM app.photos visible_photo WHERE visible_photo.owner_id=p.member_id AND app.can_photo(visible_photo.id)) '||needle);
END $migration$;
REVOKE ALL ON FUNCTION app.circle_member_ids(uuid,boolean) FROM PUBLIC;
