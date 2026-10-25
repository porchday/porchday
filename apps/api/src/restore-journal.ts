import type {Sql} from 'postgres';
import {JournalError,readJournalControl,verifyJournalChain,type JournalStore,type JournalControl} from './privacy-journal.js';

/** Privileged operator code, never mounted in the member or staff HTTP API. */
export async function replayPrivacyJournal(store:JournalStore,sql:Sql,deleteMedia:(key:string)=>Promise<void>) {
  const verified=await verifyJournalChain(store);
  const [local]=await sql`select app.safety_status() as value`;
  if(local.value.generation!==verified.control.generation || BigInt(local.value.sequence)>BigInt(verified.control.sequence))throw new JournalError('RESTORE_SOURCE_MISMATCH');
  const from=BigInt(local.value.sequence);
  await sql`update app.safety_journal_state set restore_quarantined=true`;
  const hold=new Set<string>();let replayed=0;
  for(const batch of verified.batches) {
    const missing=batch.filter(event=>BigInt(event.sequence)>from);
    if(!missing.length)continue;
    for(const event of missing)if(event.decision.action==='security_hold')hold.add(String(event.decision.id));
    const [r]=await sql`select app.replay_safety_batch(${sql.json(JSON.parse(JSON.stringify(missing)))}) as count`;replayed+=r.count;
  }
  // Credentials are intentionally never copied into the independent journal.
  // A later active-status event must not revive an old password/email/MFA key.
  await sql.begin(async tx=>{
    await tx`select set_config('app.restore_replay','on',true)`;
    for(const member of hold)await tx`select app.set_security_hold(${member}::uuid)`;
    await tx`delete from public.auth_session`;
    await tx`delete from public.auth_verification`;
    await tx`delete from public.used_email_links`;
    await tx`delete from public.pilot_invitations`;
    await tx`update public.auth_user set credentials_changed_at=now()`;
    await tx`update public.recovery_cases set session_hash=null,session_expires_at=null,contact_token_expires_at=now(),restore_token_hash=null,restore_token_expires_at=null`;
    await tx`update public.staff_users set active=false`;
    await tx`update app.moderator_keys set revoked_at=coalesce(revoked_at,now())`;
    await tx`delete from app.integration_grants`;
    await tx`update app.data_transfer_jobs set state='invalidated'`;
    await tx`delete from app.notifications`;
    await tx`update app.members set notification_preferences=jsonb_set(notification_preferences,'{push}','false'::jsonb)`;
    await tx.unsafe(`DO $$ BEGIN
      IF to_regclass('public.auth_email_outbox') IS NOT NULL THEN DELETE FROM public.auth_email_outbox; END IF;
      IF to_regclass('app.native_push_subscriptions') IS NOT NULL THEN DELETE FROM app.native_push_subscriptions; END IF;
    END $$`);
    await tx`update app.directory_epoch set epoch=epoch+1 where id`;
  });
  let cleanupDone=false;
  for(let i=0;i<2000;i++) {
    const counts=await sql.begin(async tx=>{await tx`select set_config('app.restore_replay','on',true)`;const[r]=await tx`select app.expire_batch(500) as value`;return r.value;});
    if(!counts.posts&&!counts.comments&&!counts.abandoned_media){cleanupDone=true;break;}
  }
  if(!cleanupDone)throw new JournalError('RESTORE_CLEANUP_INCOMPLETE');
  // Include object paths held independently after the corresponding DB row died.
  let deletedObjects=0;
  for(;;) {
    const pending=await sql`select id,object_key from app.deletion_outbox where completed_at is null order by id limit 100`;
    if(!pending.length)break;
    for(const object of pending) {
      if(!/^media\/[a-f0-9-]+\/[a-f0-9-]+$/.test(object.object_key))throw new JournalError('RESTORE_INVALID_MEDIA_KEY');
      await deleteMedia(object.object_key);
      await sql`update app.deletion_outbox set completed_at=now() where id=${object.id}`;
      deletedObjects++;
    }
  }
  await sql.begin(async tx=>{
    await tx`select set_config('app.restore_replay','on',true)`;
    await tx`delete from public.auth_user where id in(select member_id::text from app.identity_deletion_outbox)`;
    await tx`update app.identity_deletion_outbox set completed_at=now()`;
    await tx`update app.safety_journal_state set sequence=${verified.control.sequence}::bigint where id`;
  });
  const unchanged=await readJournalControl(store);
  if(JSON.stringify(unchanged.value)!==JSON.stringify(verified.control))throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
  return {replayed,deletedObjects,heldAccounts:hold.size,sequence:verified.control.sequence};
}

export type MediaVerification = (item:{key:string;canonicalSha256:string;byteSize:number})=>Promise<void>;
/** Bounded scan, no object bytes or SQL locks retained across the callback. */
export async function verifyRestoredMedia(sql:Sql,verify?:MediaVerification){
 let cursor='',verified=0;
 for(;;){const rows=await sql`select object_key,envelope_sha256,byte_size from app.media_assets where object_key>${cursor} and state in('ready','attached') and(app.media_deadline(id) is null or app.media_deadline(id)>now()) order by object_key limit 50`;
  if(!rows.length)return verified;
  if(!verify)throw new JournalError('RESTORE_MEDIA_VERIFICATION_REQUIRED');
  for(const row of rows){if(!/^[a-f0-9]{64}$/.test(row.envelope_sha256??''))throw new JournalError('RESTORE_MEDIA_DIGEST_MISSING');await verify({key:row.object_key,canonicalSha256:row.envelope_sha256,byteSize:Number(row.byte_size)});verified++;cursor=row.object_key;}
 }
}

/** This explicit operator step never resolves uncertain intents or skips media. */
export async function releasePrivacyQuarantine(store:JournalStore,sql:Sql,verifyMedia?:MediaVerification) {
  const {control}=await verifyJournalChain(store);
  const [local]=await sql`select app.safety_status() as value`;
  if(local.value.generation!==control.generation||local.value.sequence!==control.sequence)throw new JournalError('RESTORE_CHECKPOINT_MISMATCH');
  const [blocked]=await sql`select
    exists(select from app.deletion_outbox where completed_at is null)
    or exists(select from app.identity_deletion_outbox where completed_at is null)
    or exists(select from app.posts where expires_at<=now())
    or exists(select from app.comments where app.comment_deadline(id)<=now())
    or exists(select from public.auth_session)
    or exists(select from public.auth_verification)
    or exists(select from app.integration_grants) as value`;
  if(blocked.value)throw new JournalError('RESTORE_CLEANUP_INCOMPLETE');
  await verifyRestoredMedia(sql,verifyMedia);
  const[aged]=await sql`select exists(select from app.posts where expires_at<=now()) or exists(select from app.comments where app.comment_deadline(id)<=now()) or exists(select from app.deletion_outbox where completed_at is null) as value`;
  if(aged.value)throw new JournalError('RESTORE_CLEANUP_INCOMPLETE');
  const current=await readJournalControl(store);
  if(JSON.stringify(current.value)!==JSON.stringify(control))throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
  await sql`update app.safety_journal_state set restore_quarantined=false where id`;
  const active:JournalControl={...control,mode:'active',reason:null};
  if(!await store.put('control.json',JSON.stringify(active),{onlyIf:{etagMatches:current.etag}})) {
    await sql`update app.safety_journal_state set restore_quarantined=true where id`;
    throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
  }
}

/** A receipt proves the transaction's committed cursor reached R2 before a
 * crash interrupted pending-list cleanup. Missing receipts remain quarantined. */
export async function reconcileDurableReceipts(store:JournalStore) {
  const current=await readJournalControl(store);
  if(current.value.mode!=='quarantine')throw new JournalError('RESTORE_QUARANTINE_REQUIRED');
  const remaining=[];
  for(const intent of current.value.pending) {
    const object=await store.get(`receipts/${intent.id}.json`);
    if(!object){remaining.push(intent);continue;}
    const receipt=JSON.parse(await object.text());
    if(receipt.v!==1||receipt.id!==intent.id||receipt.generation!==current.value.generation||!/^(0|[1-9][0-9]*)$/.test(receipt.sequence)||BigInt(receipt.sequence)>BigInt(current.value.sequence))throw new JournalError('INVALID_JOURNAL_RECEIPT');
    if(receipt.head) {
      const batch=await store.get(receipt.head.key);
      const {sha256}=await import('./privacy-journal.js');
      if(!batch||await sha256(await batch.text())!==receipt.head.hash)throw new JournalError('INVALID_JOURNAL_RECEIPT');
    }
  }
  if(!await store.put('control.json',JSON.stringify({...current.value,pending:remaining}),{onlyIf:{etagMatches:current.etag}}))throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
  return {resolved:current.value.pending.length-remaining.length,unresolved:remaining.length};
}
