import type {Sql} from 'postgres';
import {z} from 'zod';
import {JournalError,readJournalControl,verifyJournalChain,controlSchema,sha256,type JournalStore,type JournalControl} from './privacy-journal.js';

/** Privileged operator code, never mounted in the member or staff HTTP API. */
export async function replayPrivacyJournal(store:JournalStore,sql:Sql,deleteMedia:(key:string)=>Promise<void>) {
  const verified=await verifyJournalChain(store);
  const [local]=await sql`select app.safety_status() as value`;
  if(local.value.generation!==verified.control.generation || BigInt(local.value.sequence)>BigInt(verified.control.sequence))throw new JournalError('RESTORE_SOURCE_MISMATCH');
  const from=BigInt(local.value.sequence);
  await sql`update app.safety_journal_state set restore_quarantined=true`;
  const hold=new Set<string>();let replayed=0,heldAccounts=0;
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
    // A later journaled account deletion is final; do not recreate it or make
    // an earlier credential hold prevent recovery of the remaining accounts.
    for(const member of hold){const rows=await tx`select app.set_security_hold(id) from app.members where id=${member}::uuid`;heldAccounts+=rows.length;}
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
  return {replayed,deletedObjects,heldAccounts,sequence:verified.control.sequence};
}

export type MediaVerification = (item:{key:string;sha256:string;byteSize:number})=>Promise<void>;
/** Bounded scan, no object bytes or SQL locks retained across the callback. */
export async function verifyRestoredMedia(sql:Sql,verify?:MediaVerification){
 let cursor='',verified=0;
 for(;;){const rows=await sql`select object_key,raw_sha256,byte_size from app.media_assets where object_key>${cursor} and state in('ready','attached') and(app.media_deadline(id) is null or app.media_deadline(id)>now()) order by object_key limit 50`;
  if(!rows.length)return verified;
  if(!verify)throw new JournalError('RESTORE_MEDIA_VERIFICATION_REQUIRED');
  for(const row of rows){if(!/^[a-f0-9]{64}$/.test(row.raw_sha256??''))throw new JournalError('RESTORE_MEDIA_DIGEST_MISSING');await verify({key:row.object_key,sha256:row.raw_sha256,byteSize:Number(row.byte_size)});verified++;cursor=row.object_key;}
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

const digest=z.string().regex(/^[a-f0-9]{64}$/);
const originalStatus=z.object({generation:z.uuid(),sequence:z.string().regex(/^(0|[1-9][0-9]*)$/),quarantined:z.literal(false)}).strict();
const observedStatus=originalStatus.extend({quarantined:z.boolean()});
/** An operator attestation is evidence to review, never a runtime auto-repair flag. */
export const originalPrimaryRecoveryTicketSchema=z.object({
  v:z.literal(1),kind:z.literal('porchday-original-primary-recovery'),id:z.uuid(),environment:z.enum(['staging','production']),
  source:z.object({organization:z.string().min(1),name:z.string().min(1),branch:z.literal('main'),branchId:z.string().min(1),reviewedCommit:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),
  journalBucket:z.string().min(1),mediaBucket:z.string().min(1),reviewedAt:z.iso.datetime(),writersDrainedAt:z.iso.datetime(),
  unrestoredPrimaryConfirmed:z.literal(true),noRestoreOrRoutingChangeConfirmed:z.literal(true),writersDrained:z.literal(true),
  evidenceSha256:digest,initialControl:controlSchema,initialControlSha256:digest,initialSql:originalStatus,capabilitiesSha256:digest,
}).strict();
export type OriginalPrimaryRecoveryTicket=z.infer<typeof originalPrimaryRecoveryTicketSchema>;

// Fixed identifiers only. Full row hashes are calculated inside SQL: tokens,
// credential hashes, addresses and encrypted key material never leave the DB.
const preservedTables=[
  'public.auth_user','public.auth_account','public.auth_two_factor','public.auth_session','public.auth_verification',
  'public.used_email_links','public.pilot_invitations','public.auth_email_outbox','public.recovery_cases','public.recovery_reviews',
  'public.recovery_evidence','public.security_contact_history','public.staff_users',
  'app.members','app.device_keys','app.encrypted_key_backups','app.recovery_keys','app.integration_grants',
  'app.moderator_identities','app.moderator_keys','app.native_push_subscriptions','app.native_push_outbox',
  'app.push_subscriptions','app.push_outbox','app.data_transfer_jobs','app.notifications',
] as const;

/** Read-only, repeatable snapshot suitable for a restricted operator ticket. */
export async function inspectOriginalPrimaryState(sql:Sql){
  return sql.begin('isolation level repeatable read read only',async tx=>{
    const[status]=await tx`select app.safety_status() as value`;
    const tables=[];
    for(const table of preservedTables){
      const[row]=await tx.unsafe(`select count(*)::int as count,encode(sha256(convert_to(coalesce(string_agg(row_hash,'' order by row_hash),''),'UTF8')),'hex') as sha256 from (select encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') as row_hash from ${table} t) hashed`);
      tables.push({table,count:Number(row.count),sha256:String(row.sha256)});
    }
    const[blocked]=await tx`select exists(select from app.deletion_outbox where completed_at is null)
      or exists(select from app.identity_deletion_outbox where completed_at is null)
      or exists(select from app.posts where expires_at<=now())
      or exists(select from app.comments where app.comment_deadline(id)<=now())
      or exists(select from app.media_assets where (state<>'attached' and created_at<now()-interval '24 hours')or app.media_deadline(id)<=now()) as value`;
    return {status:observedStatus.parse(status.value),capabilities:{tables,sha256:await sha256(JSON.stringify(tables))},cleanupBlocked:blocked.value===true};
  });
}

/** Reopen only an externally verified, unrestored original primary. Unlike
 * restore release this does not modify SQL or invalidate live capabilities. */
export async function recoverOriginalPrimary(store:JournalStore,sql:Sql,untrustedTicket:unknown,verifyMedia:MediaVerification){
  const ticket=originalPrimaryRecoveryTicketSchema.parse(untrustedTicket),now=Date.now();
  const reviewed=Date.parse(ticket.reviewedAt),drained=Date.parse(ticket.writersDrainedAt);
  if(reviewed>now||now-reviewed>30*60_000||drained>reviewed||now-drained<120_000)throw new JournalError('ORIGINAL_PRIMARY_ATTESTATION_EXPIRED');
  const initial=ticket.initialControl;
  if(initial.mode!=='quarantine'||initial.reason!=='unresolved_privacy_operation'||!initial.pending.length
    ||new Set(initial.pending.map(p=>p.id)).size!==initial.pending.length
    ||initial.pending.some(p=>Date.parse(p.started_at)>drained)
    ||ticket.initialSql.generation!==initial.generation||ticket.initialSql.sequence!==initial.sequence
    ||await sha256(JSON.stringify(initial))!==ticket.initialControlSha256)throw new JournalError('ORIGINAL_PRIMARY_TICKET_INVALID');
  const current=await readJournalControl(store);
  if(JSON.stringify(current.value)!==JSON.stringify(initial))throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
  const assertState=async()=>{
    const state=await inspectOriginalPrimaryState(sql);
    if(JSON.stringify(state.status)!==JSON.stringify(ticket.initialSql))throw new JournalError('ORIGINAL_PRIMARY_DATABASE_CHANGED');
    if(state.capabilities.sha256!==ticket.capabilitiesSha256)throw new JournalError('ORIGINAL_PRIMARY_CAPABILITIES_CHANGED');
    if(state.cleanupBlocked)throw new JournalError('RESTORE_CLEANUP_INCOMPLETE');
    return state;
  };
  const before=await assertState();
  // This first incident path accepts only an already-caught-up original. An
  // uncheckpointed tail requires the separate recovery workflow, not a retry
  // that loses its original control pin after publishing a new checkpoint.
  const checkpoint=initial;
  if(checkpoint.mode!==initial.mode||checkpoint.reason!==initial.reason||checkpoint.generation!==initial.generation
    ||checkpoint.sequence!==ticket.initialSql.sequence||JSON.stringify(checkpoint.pending)!==JSON.stringify(initial.pending))throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
  // This candidate is never exposed to the runtime guard. The actual pending
  // list remains intact until exact durable receipts and all release checks pass.
  const reconciled:JournalControl={...checkpoint,pending:[]};
  const verifyCandidate=async()=>{
    const actual=await readJournalControl(store);
    if(JSON.stringify(actual.value)!==JSON.stringify(checkpoint))throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
    return verifyJournalChain({
      async get(key){return key==='control.json'?{etag:actual.etag,text:async()=>JSON.stringify(reconciled)}:store.get(key);},
      async put(){throw new JournalError('ORIGINAL_PRIMARY_VERIFIER_READ_ONLY');},
    });
  };
  await verifyCandidate();
  const verifiedMedia=await verifyRestoredMedia(sql,verifyMedia);
  await assertState();
  const ticketHash=await sha256(JSON.stringify(ticket));
  for(const intent of initial.pending){
    const text=JSON.stringify({v:1,id:intent.id,generation:checkpoint.generation,sequence:checkpoint.sequence,head:checkpoint.head,
      operator_verified_original:true,recovery_ticket_sha256:ticketHash,source:ticket.source,evidence_sha256:ticket.evidenceSha256,initial_control_sha256:ticket.initialControlSha256});
    const key=`receipts/${intent.id}.json`,existing=await store.get(key);
    if(existing){if(await existing.text()!==text)throw new JournalError('ORIGINAL_PRIMARY_RECEIPT_CONFLICT');}
    else if(!await store.put(key,text,{onlyIf:{etagDoesNotMatch:'*'}}))throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
    const durable=await store.get(key);
    if(!durable||await durable.text()!==text)throw new JournalError('INVALID_JOURNAL_RECEIPT');
  }
  await verifyCandidate();
  const after=await assertState(),latest=await readJournalControl(store);
  if(JSON.stringify(latest.value)!==JSON.stringify(checkpoint))throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
  const active:JournalControl={...reconciled,mode:'active',reason:null};
  let published:Awaited<ReturnType<JournalStore['put']>>;
  try{published=await store.put('control.json',JSON.stringify(active),{onlyIf:{etagMatches:latest.etag}});}
  catch{throw new JournalError('ORIGINAL_PRIMARY_RELEASE_UNCONFIRMED');}
  if(!published)throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
  try{if(JSON.stringify((await readJournalControl(store)).value)!==JSON.stringify(active))throw new Error();}
  catch{throw new JournalError('ORIGINAL_PRIMARY_RELEASE_UNCONFIRMED');}
  return {recovered:true,sequence:active.sequence,resolvedIntents:initial.pending.length,verifiedMedia,
    ticketSha256:ticketHash,initialControlSha256:ticket.initialControlSha256,finalControlSha256:await sha256(JSON.stringify(active)),
    capabilitiesBefore:before.capabilities,capabilitiesAfter:after.capabilities};
}
