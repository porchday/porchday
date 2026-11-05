-- Lower new connection admission to 150, including family. Existing pairs are
-- preserved even if a member is above the new cap. Keep both endpoint locks,
-- idempotent acceptance and existing history/label behavior unchanged.
CREATE OR REPLACE FUNCTION app.accept_connection_with_preferences(request_id uuid,own_history text,own_kind text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r app.connection_requests; result uuid;
BEGIN
 IF NOT app.may_write() OR own_history IS NULL OR own_history NOT IN('future','full')
  OR own_kind IS NULL OR own_kind NOT IN('friend','family') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT * INTO r FROM app.connection_requests WHERE id=request_id;
 IF r.recipient IS DISTINCT FROM app.actor() THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 PERFORM app.lock_pair(r.sender,r.recipient);
 SELECT * INTO r FROM app.connection_requests WHERE id=request_id FOR UPDATE;
 IF r.recipient IS DISTINCT FROM app.actor() THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF r.state='accepted' THEN
  SELECT id INTO result FROM app.connections WHERE member_a=least(r.sender,r.recipient) AND member_b=greatest(r.sender,r.recipient);
  IF result IS NULL THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  RETURN result;
 END IF;
 IF r.state<>'pending' OR app.blocked(r.sender,r.recipient) OR NOT EXISTS(SELECT FROM app.members WHERE id=r.sender AND status='active') THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 IF (SELECT count(*) FROM app.connections WHERE r.sender IN(member_a,member_b))>=150 OR (SELECT count(*) FROM app.connections WHERE r.recipient IN(member_a,member_b))>=150 THEN RAISE EXCEPTION 'CONNECTION_LIMIT'; END IF;
 INSERT INTO app.connections(member_a,member_b,kind,kind_a,kind_b,history_a,history_b)
 VALUES(least(r.sender,r.recipient),greatest(r.sender,r.recipient),r.kind,
  CASE WHEN r.sender<r.recipient THEN r.kind ELSE own_kind END,
  CASE WHEN r.sender<r.recipient THEN own_kind ELSE r.kind END,
  CASE WHEN r.sender<r.recipient THEN r.history ELSE own_history END,
  CASE WHEN r.sender<r.recipient THEN own_history ELSE r.history END) RETURNING id INTO result;
 UPDATE app.connection_requests SET state='accepted' WHERE id=request_id;
 UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
 INSERT INTO app.notifications(recipient,actor,kind,dedupe_key) VALUES(r.sender,r.recipient,'connection_accepted','connection:'||request_id) ON CONFLICT DO NOTHING;
 RETURN result;
END $$;

-- Invitation signup uses the same cap and pair locking as explicit acceptance.
CREATE OR REPLACE FUNCTION public.invitation_history_verified() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE candidate record; receipt public.platform_invitation_history;
BEGIN
 IF NOT NEW."emailVerified" OR (TG_OP='UPDATE' AND OLD."emailVerified") THEN RETURN NEW; END IF;
 FOR candidate IN SELECT id,sender_id FROM public.platform_invitation_history WHERE claimed_user=NEW.id ORDER BY id LOOP
  PERFORM app.lock_pair(candidate.sender_id::uuid,NEW.id::uuid);
  SELECT * INTO receipt FROM public.platform_invitation_history WHERE id=candidate.id FOR UPDATE;
  IF NOT FOUND OR receipt.claimed_user IS DISTINCT FROM NEW.id OR receipt.revoked_at IS NOT NULL THEN CONTINUE; END IF;
  IF receipt.connection_kind IS NOT NULL AND receipt.connection_checked_at IS NULL THEN
   -- Admission may finish if the inviter is no longer available, but never
   -- bypass a block or restore a relationship removed after first verification.
   IF app.platform_inviter(receipt.sender_id) IS NOT NULL
    AND EXISTS(SELECT FROM app.members WHERE id=NEW.id::uuid AND status='active')
    AND NOT app.blocked(receipt.sender_id::uuid,NEW.id::uuid)
    AND receipt.sender_id<>NEW.id THEN
    IF NOT EXISTS(SELECT FROM app.connections WHERE member_a=least(receipt.sender_id::uuid,NEW.id::uuid) AND member_b=greatest(receipt.sender_id::uuid,NEW.id::uuid)) THEN
     IF (SELECT count(*) FROM app.connections WHERE receipt.sender_id::uuid IN(member_a,member_b))>=150
      OR (SELECT count(*) FROM app.connections WHERE NEW.id::uuid IN(member_a,member_b))>=150 THEN RAISE EXCEPTION 'CONNECTION_LIMIT'; END IF;
     INSERT INTO app.connections(member_a,member_b,kind,kind_a,kind_b,history_a,history_b)
      VALUES(least(receipt.sender_id::uuid,NEW.id::uuid),greatest(receipt.sender_id::uuid,NEW.id::uuid),receipt.connection_kind,receipt.connection_kind,receipt.connection_kind,
       CASE WHEN receipt.sender_id::uuid<NEW.id::uuid THEN receipt.connection_history ELSE 'full' END,
       CASE WHEN receipt.sender_id::uuid>NEW.id::uuid THEN receipt.connection_history ELSE 'full' END);
     UPDATE app.directory_epoch SET epoch=epoch+1 WHERE id;
     INSERT INTO app.notifications(recipient,actor,kind,dedupe_key)
      VALUES(receipt.sender_id::uuid,NEW.id::uuid,'connection_accepted','invitation-connection:'||receipt.id) ON CONFLICT DO NOTHING;
    END IF;
   END IF;
   UPDATE public.platform_invitation_history SET connection_checked_at=now() WHERE id=receipt.id;
  END IF;
  UPDATE public.platform_invitation_history SET joined_at=coalesce(joined_at,now()) WHERE id=receipt.id;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.invitation_history_verified() FROM PUBLIC;

