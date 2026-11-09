-- Add limited previews only after the existing delivery-time authorization check.
-- Never decrypt or copy post/caption content into notification storage.
DO $migration$
DECLARE name text; definition text; needle text;
BEGIN
 FOREACH name IN ARRAY ARRAY['prepare_push_delivery','prepare_native_push_delivery'] LOOP
  SELECT pg_get_functiondef(('app.'||name||'(uuid,uuid)')::regprocedure) INTO definition;
  needle:='jsonb_build_object(''count'',feed_state->''count'',''kind'',n.kind,''id'',n.id)';
  IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'UNRECOGNIZED_PUSH_PREVIEW_READER'; END IF;
  definition:=replace(definition,needle,$new$(jsonb_build_object('count',feed_state->'count','kind',n.kind,'id',n.id) ||
   CASE WHEN n.kind='feed_activity' THEN jsonb_build_object(
    'author',(SELECT p.handle FROM app.profiles p WHERE p.member_id=n.actor),
    'content',CASE WHEN n.post_id IS NOT NULL THEN 'post' ELSE 'media' END)
   ELSE '{}'::jsonb END)$new$);
  EXECUTE definition;
 END LOOP;
END $migration$;
