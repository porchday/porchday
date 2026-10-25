-- Remove only the reviewed attachment of a profile/group slot. The caller's
-- encrypted surface revision is updated in the same transaction by the API.
-- Existing DELETE triggers record the privacy journal and R2 deletion outbox.
CREATE FUNCTION app.remove_surface_media(kind text,target uuid,removals jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE removal jsonb; current_id uuid;
BEGIN
 IF NOT app.may_write() OR kind IS NULL OR kind NOT IN('profile','group') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF jsonb_typeof(removals) IS DISTINCT FROM 'array' OR jsonb_array_length(removals)>(CASE WHEN kind='profile' THEN 3 ELSE 1 END) THEN RAISE EXCEPTION 'INVALID_MEDIA_REMOVAL'; END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(removals) r WHERE
   jsonb_typeof(r) IS DISTINCT FROM 'object' OR jsonb_typeof(r->'id') IS DISTINCT FROM 'string' OR
   (r->>'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' OR
   jsonb_typeof(r->'slot') IS DISTINCT FROM 'string' OR
   (kind='profile' AND r->>'slot' NOT IN('avatar','cover','background')) OR
   (kind='group' AND r->>'slot'<>'image')) OR
   (SELECT count(*)<>count(DISTINCT r->>'slot') OR count(*)<>count(DISTINCT r->>'id') FROM jsonb_array_elements(removals) r)
 THEN RAISE EXCEPTION 'INVALID_MEDIA_REMOVAL'; END IF;
 PERFORM app.lock_epoch();
 IF kind='profile' THEN
  IF target<>app.actor() THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM 1 FROM app.profiles WHERE member_id=target FOR UPDATE;
 ELSE
  IF NOT app.group_manager(target,app.actor()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM 1 FROM app.groups WHERE id=target FOR UPDATE;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 FOR removal IN SELECT r FROM jsonb_array_elements(removals) r ORDER BY r->>'slot' LOOP
  current_id:=NULL;
  SELECT id INTO current_id FROM app.media_assets WHERE slot=removal->>'slot' AND
    ((kind='profile' AND profile_member_id=target) OR(kind='group' AND group_id=target)) FOR UPDATE;
  -- An expired/deleted image can leave a stale reference inside an opaque
  -- envelope. Clearing it is safe when the slot is empty. Never delete a newer
  -- replacement based on an old editor's ID.
  IF current_id IS NOT NULL AND current_id<>(removal->>'id')::uuid THEN RAISE EXCEPTION 'MEDIA_ATTACHMENT_CHANGED'; END IF;
  IF current_id IS NOT NULL THEN DELETE FROM app.media_assets WHERE id=current_id; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.remove_surface_media(text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.remove_surface_media(text,uuid,jsonb) TO porchday_social;
