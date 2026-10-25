/** Bounded staging-only whole-account deletion evidence. Mutations use the member API only.
 * prepare/request/status are operator-controlled phases; never call request before the restore cut is released.
 */
import postgres,{type Sql} from 'postgres';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {check,readPrivate,writePrivate,SmokeClient,SmokeError,stagingOrigin} from './hosted-smoke-support.js';
import {readJournalControl,eventSchema,type JournalStore} from '../apps/api/src/privacy-journal.js';
import {syntheticC,validateDeletionTicket,ticketHash,issueDeletion,finalOutboxComplete,deletionFailure,type DeletionState,type DeletionTicket,type DeletionIntent,type DeletionReceipt,type DeletionAccount,type MediaEvidence} from './hosted-deletion-support.js';

const directory='artifacts/private/hosted-smoke/',ticketPath=directory+'account-deletion-c.ticket.json',intentPath=directory+'account-deletion-c.intent.json',receiptPath=directory+'account-deletion-c.receipt.json';
const phase=process.argv[2];let stage='SETUP';let sql:Sql|undefined;const transientClients:SmokeClient[]=[];
const fixedOutput=(value:Record<string,unknown>)=>console.log(JSON.stringify({phase,...value}));
const pointer=z.object({key:z.string().regex(/^batches\/[a-f0-9-]{36}\/[0-9]+-[0-9]+-[a-f0-9]{64}\.json$/),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const batchSchema=z.object({v:z.literal(1),generation:z.uuid(),from:z.string().regex(/^\d+$/),to:z.string().regex(/^\d+$/),previous:pointer.nullable(),events:z.array(eventSchema).min(1).max(500)}).strict();

async function login(account:DeletionAccount){
 const api=new SmokeClient();transientClients.push(api);
 const login=await api.json('/api/auth/sign-in/email','POST',{email:account.email,password:account.password});check(!login.twoFactorRedirect,'DELETION_MFA_UNEXPECTED');
 const session=await api.json('/api/auth/get-session'),me=await api.json('/api/v1/me');
 check(session.user?.id===account.id&&session.user?.email?.toLowerCase()===account.email.toLowerCase()&&session.user?.emailVerified===true&&me.id===account.id&&me.handle===account.handle&&me.status==='active'&&typeof session.session?.id==='string','DELETION_LOGIN_IDENTITY_MISMATCH');
 return {api,session:{id:session.session.id as string,cookie:api.cookieHeader()}};
}
async function optionalPrivate<T>(path:string):Promise<T|null>{try{return await readPrivate<T>(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}

try{
 check(['prepare','request','status'].includes(phase)&&process.argv.length===4&&process.argv[3]==='--run','DELETION_EXPLICIT_PHASE_REQUIRED');
 const state=await readPrivate<DeletionState>(directory+'state.json'),c=syntheticC(state,phase==='status');
 const resources=JSON.parse(await readFile(new URL('../infra/resources.json',import.meta.url),'utf8')),env=resources.environments.staging;
 check(env.bucket==='porchday-staging-media'&&env.recovery_journal_bucket==='porchday-staging-recovery-journal','DELETION_STAGING_BUCKET_REQUIRED');
 const connection=process.env.PORCHDAY_STAGING_DATABASE_MIGRATION_URL;check(connection,'DELETION_STAGING_DATABASE_REQUIRED');
 const url=new URL(connection);check(url.protocol==='postgres:'||url.protocol==='postgresql:','DELETION_STAGING_DATABASE_INVALID');
 check(url.hostname.endsWith('.pg.psdb.cloud')&&decodeURIComponent(url.username).endsWith('.'+env.database.branch_id)&&url.port==='5432','DELETION_STAGING_DATABASE_MISMATCH');
 sql=postgres(connection,{max:1,prepare:false,fetch_types:false,connect_timeout:10,ssl:'verify-full',connection:{default_transaction_read_only:true,statement_timeout:15000},onnotice:()=>{}});
 const db=sql;
 const [readOnly]=await db`show transaction_read_only`;check(readOnly.transaction_read_only==='on','DELETION_READ_ONLY_DATABASE_REQUIRED');
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN??process.env.CF_API_TOKEN;
 check(account&&/^[a-f0-9]{32}$/i.test(account)&&token,'DELETION_R2_CONFIGURATION_REQUIRED');
 async function r2(bucket:string,key?:string){
  check([env.bucket,env.recovery_journal_bucket].includes(bucket),'DELETION_R2_BUCKET_INVALID');
  if(key!==undefined)check(key==='control.json'||/^batches\/[a-f0-9-]{36}\/[0-9]+-[0-9]+-[a-f0-9]{64}\.json$/.test(key)||new RegExp('^media/'+c.id+'/[a-f0-9-]{36}$').test(key),'DELETION_R2_KEY_INVALID');
  let response:Response;try{response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}`+(key===undefined?'':'/objects/'+key),{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new SmokeError('DELETION_R2_UNAVAILABLE');}
  check(response.ok||(key!==undefined&&response.status===404),'DELETION_R2_READ_FAILED');return response;
 }
 for(const bucket of [env.bucket,env.recovery_journal_bucket]){
  const metadata=await(await r2(bucket)).json() as any;check(metadata.success===true&&metadata.result?.name===bucket,'DELETION_R2_BUCKET_UNVERIFIED');
 }
 async function objectDigest(key:string):Promise<{sha256:string;byte_size:number}|null>{
  const response=await r2(env.bucket,key);if(response.status===404){await response.body?.cancel();return null;}
  check(response.body,'DELETION_R2_BODY_MISSING');const reader=response.body.getReader(),hash=createHash('sha256');let byte_size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;byte_size+=value.byteLength;check(byte_size<=22020096,'DELETION_R2_OBJECT_TOO_LARGE');hash.update(value);}}finally{await reader.cancel();}
  return {sha256:hash.digest('hex'),byte_size};
 }
 const journal:JournalStore={
  async get(key){const response=await r2(env.recovery_journal_bucket,key);if(response.status===404){await response.body?.cancel();return null;}check(response.body,'DELETION_JOURNAL_BODY_MISSING');const reader=response.body.getReader(),parts:Uint8Array[]=[];let length=0;try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;check(length<=1048576,'DELETION_JOURNAL_OBJECT_TOO_LARGE');parts.push(value);}}finally{await reader.cancel();}const value=Buffer.concat(parts).toString('utf8');return {etag:response.headers.get('etag')??'',text:async()=>value};},
  async put(){throw new SmokeError('DELETION_JOURNAL_WRITES_FORBIDDEN');}
 };
 async function inventory(){
  return db.begin('read only',async tx=>{
   const devices=await tx`select id from app.device_keys where member_id=${c.id} order by id limit 1001`;
   const posts=await tx`select id from app.posts where author_id=${c.id} order by id limit 1001`;
   const comments=await tx`with recursive affected as(select id from app.comments where author_id=${c.id} or post_id in(select id from app.posts where author_id=${c.id}) union select child.id from app.comments child join affected parent on child.parent_id=parent.id) select id from affected order by id limit 1001`;
   const media=await tx`select id,object_key,raw_sha256 as sha256,byte_size,app.media_deadline(id) as expires_at,state from app.media_assets where owner_id=${c.id} order by id limit 33`;
   const [groups]=await tx`select count(*)::int as count from app.groups where owner_id=${c.id}`;check(groups.count===0,'DELETION_OWNED_GROUPS_REQUIRE_REVIEW');
   check(media.every(m=>['ready','attached'].includes(m.state)),'DELETION_PENDING_MEDIA_REQUIRES_REVIEW');
   return {deviceIds:devices.map(d=>String(d.id)),postIds:posts.map(p=>String(p.id)),commentIds:comments.map(p=>String(p.id)),media:media.map(m=>({id:String(m.id),object_key:String(m.object_key),sha256:String(m.sha256),byte_size:Number(m.byte_size),expires_at:m.expires_at?new Date(m.expires_at).toISOString():null}))};
  });
 }
 async function verifyPresent(media:MediaEvidence[]){for(const item of media){const actual=await objectDigest(item.object_key);check(actual&&actual.sha256===item.sha256&&actual.byte_size===item.byte_size,'DELETION_SOURCE_CIPHERTEXT_MISMATCH');}}
 if(phase==='prepare'){
  check(!(await optionalPrivate(ticketPath))&&!(await optionalPrivate(intentPath)),'DELETION_TICKET_ALREADY_EXISTS');
  const first=await login(c),second=await login(c),data=await inventory(),control=(await readJournalControl(journal)).value;
  check(control.mode==='active'&&!control.pending.length,'DELETION_JOURNAL_NOT_STABLE');
  const ticket:DeletionTicket={v:1,synthetic:true,origin:stagingOrigin,run:state.run,memberId:c.id,handle:c.handle,createdAt:new Date().toISOString(),bucket:env.bucket,branchId:env.database.branch_id,protectedMembers:state.accounts.slice(0,2).map(a=>a.id),sessions:[first.session,second.session],...data,journal:{generation:control.generation,sequence:control.sequence}};
  validateDeletionTicket(ticket,state,Date.now(),true);await verifyPresent(ticket.media);
  await writePrivate(ticketPath,ticket,true);
  transientClients.length=0; // Ticket intentionally retains two live synthetic sessions for revocation proof.
  fixedOutput({prepared:true,account:'synthetic-C',mediaObjects:ticket.media.length,posts:ticket.postIds.length,comments:ticket.commentIds.length,deletionRequested:false});
 }else{
  const ticket=await readPrivate<DeletionTicket>(ticketPath);validateDeletionTicket(ticket,state,Date.now(),phase==='request');check(ticket.branchId===env.database.branch_id,'DELETION_TICKET_DATABASE_MISMATCH');
  const hash=ticketHash(ticket);
  if(phase==='request'){
   check(!(await optionalPrivate(intentPath)),'DELETION_ALREADY_ATTEMPTED_INSPECT_STATUS');
   const current=await inventory();check(JSON.stringify(current)===JSON.stringify({deviceIds:ticket.deviceIds,postIds:ticket.postIds,commentIds:ticket.commentIds,media:ticket.media}),'DELETION_INVENTORY_CHANGED');
   await verifyPresent(ticket.media);
   const control=(await readJournalControl(journal)).value;check(control.mode==='active'&&!control.pending.length&&control.generation===ticket.journal.generation,'DELETION_JOURNAL_NOT_STABLE');
   const session=await login(c),[clock]=await db`select clock_timestamp() as now`;
   const intent:DeletionIntent={v:1,ticketSHA256:hash,startedAt:new Date(clock.now).toISOString(),session:session.session};
   await issueDeletion({persistIntent:()=>writePrivate(intentPath,intent,true),removeAccount:()=>session.api.json('/api/v1/account','DELETE',{confirm:'DELETE'}),persistReceipt:()=>writePrivate(receiptPath,{v:1,ticketSHA256:hash,acknowledgedAt:new Date().toISOString()} satisfies DeletionReceipt,true)});
   fixedOutput({acknowledged:true,account:'synthetic-C',physicalCleanupVerified:false,next:'status'});
  }else{
   const intent=await readPrivate<DeletionIntent>(intentPath),receipt=await optionalPrivate<DeletionReceipt>(receiptPath);
   check(intent.v===1&&intent.ticketSHA256===hash&&Number.isFinite(Date.parse(intent.startedAt))&&(!receipt||(receipt.v===1&&receipt.ticketSHA256===hash)),'DELETION_INTENT_MISMATCH');
   check(Date.parse(intent.startedAt)<=Date.now()&&Date.parse(intent.startedAt)>Date.now()-24*3600000,'DELETION_STATUS_WINDOW_EXPIRED');
   stage='STATUS_SESSIONS';const api=new SmokeClient();let sessionsRevoked=true;
   for(const session of [...ticket.sessions,intent.session]){
    const denied=await api.request('/api/v1/me','GET',undefined,session.cookie);check([401,403].includes(denied.status),'DELETION_SESSION_STILL_AUTHORIZED');await denied.body?.cancel();
    const ended=await api.request('/api/auth/get-session','GET',undefined,session.cookie);check(ended.status===200,'DELETION_SESSION_READ_FAILED');const data=await ended.json() as any;check(!data?.user,'DELETION_AUTH_SESSION_STILL_LIVE');
   }
   // Fresh sign-in must also fail, independent of the captured cookies.
   const denied=await api.request('/api/auth/sign-in/email','POST',{email:c.email,password:c.password});check([400,401,403].includes(denied.status),'DELETION_PASSWORD_LOGIN_SUCCEEDED');await denied.body?.cancel();
   stage='STATUS_DATABASE_COUNTS';const [counts]=await db`select jsonb_build_object(
    'members',(select count(*) from app.members where id=${c.id}),'profiles',(select count(*) from app.profiles where member_id=${c.id}),
    'devices',(select count(*) from app.device_keys where member_id=${c.id}),'recovery_keys',(select count(*) from app.recovery_keys where member_id=${c.id}),
    'key_backups',(select count(*) from app.encrypted_key_backups where member_id=${c.id}),'device_challenges',(select count(*) from app.device_challenges where member_id=${c.id}),
    'posts',(select count(*) from app.posts where author_id=${c.id} or id in(select jsonb_array_elements_text(${db.json(ticket.postIds)}::jsonb)::uuid)),
    'comments',(select count(*) from app.comments where author_id=${c.id} or id in(select jsonb_array_elements_text(${db.json(ticket.commentIds)}::jsonb)::uuid)),
    'post_reactions',(select count(*) from app.post_reactions where member_id=${c.id}),'comment_reactions',(select count(*) from app.comment_reactions where member_id=${c.id}),
    'post_recipients',(select count(*) from app.post_recipients where member_id=${c.id}),'media',(select count(*) from app.media_assets where owner_id=${c.id}),
    'connections',(select count(*) from app.connections where member_a=${c.id} or member_b=${c.id}),'requests',(select count(*) from app.connection_requests where sender=${c.id} or recipient=${c.id}),
    'blocks',(select count(*) from app.blocks where actor=${c.id} or target=${c.id}),'mutes',(select count(*) from app.mutes where actor=${c.id} or target=${c.id}),
    'groups',(select count(*) from app.groups where owner_id=${c.id}),'memberships',(select count(*) from app.group_memberships where member_id=${c.id}),
    'invitations',(select count(*) from app.group_invitations where inviter=${c.id} or recipient=${c.id}),'notifications',(select count(*) from app.notifications where actor=${c.id} or recipient=${c.id}),
    'integration_clients',(select count(*) from app.integration_clients where member_id=${c.id}),'integrations',(select count(*) from app.integration_grants where member_id=${c.id}),'transfers',(select count(*) from app.data_transfer_jobs where member_id=${c.id}),
    'web_push',(select count(*) from app.push_subscriptions where member_id=${c.id}),'native_push',(select count(*) from app.native_push_subscriptions where member_id=${c.id}),
    'auth_users',(select count(*) from public.auth_user where id=${c.id}),'auth_sessions',(select count(*) from public.auth_session where "userId"=${c.id}),
    'auth_accounts',(select count(*) from public.auth_account where "userId"=${c.id}),'auth_factors',(select count(*) from public.auth_two_factor where "userId"=${c.id}),
    'contact_history',(select count(*) from public.security_contact_history where member_id=${c.id}),'account_email',(select count(*) from public.auth_email_outbox where member_id=${c.id})
   ) as value`;
   check(Object.values(counts.value).every(n=>Number(n)===0),'DELETION_DATABASE_ROWS_REMAIN');
   stage='STATUS_PROTECTED_ACCOUNTS';const protectedRows=await db`select m.id,m.status,u."emailVerified" as verified from app.members m join public.auth_user u on u.id=m.id::text where m.id in(select jsonb_array_elements_text(${db.json(ticket.protectedMembers)}::jsonb)::uuid)`;
   check(protectedRows.length===2&&protectedRows.every(m=>m.status==='active'&&m.verified),'DELETION_PROTECTED_ACCOUNTS_CHANGED');
   stage='STATUS_LEDGER';const [ledger]=await db`select exists(select from app.deletion_ledger where kind='members' and object_id=${c.id} and deleted_at>=${intent.startedAt}::timestamptz) as present`;
   check(ledger.present,'DELETION_DURABLE_MARKER_MISSING');
   stage='STATUS_OUTBOXES';const identities=await db`select completed_at from app.identity_deletion_outbox where member_id=${c.id}`;
   check(identities.length===1,'DELETION_IDENTITY_OUTBOX_MISSING');
   const [authPending]=await db`select (select count(*) from public.pilot_invitations where consumed_user=${c.id})+(select count(*) from public.auth_verification where value=${c.id}) as count`;
   const outboxes=await db`select object_key,attempts,created_at,completed_at from app.deletion_outbox where object_key in(select jsonb_array_elements_text(${db.json(ticket.media.map(m=>m.object_key))}::jsonb)) order by object_key`;
   check(outboxes.length===ticket.media.length,'DELETION_MEDIA_OUTBOX_MISSING');
   const rows=outboxes.map(row=>({object_key:String(row.object_key),attempts:Number(row.attempts),created_at:new Date(row.created_at).toISOString(),completed_at:row.completed_at?new Date(row.completed_at).toISOString():null}));
   check(rows.every(row=>Date.parse(row.created_at)>=Date.parse(intent.startedAt)),'DELETION_MEDIA_ALREADY_REMOVED_BEFORE_REQUEST');
   stage='STATUS_MEDIA_ABSENCE';let absent=true;for(const item of ticket.media){const response=await r2(env.bucket,item.object_key);absent&&=response.status===404;await response.body?.cancel();}
   stage='STATUS_JOURNAL';const control=(await readJournalControl(journal)).value;check(control.mode==='active'&&control.generation===ticket.journal.generation,'DELETION_JOURNAL_UNAVAILABLE');
   let pointerValue=control.head,expected=BigInt(control.sequence),memberJournaled=false;const mediaJournaled=new Set(ticket.media.map(m=>m.object_key));
   for(let page=0;pointerValue&&page<128;page++){
    const object=await journal.get(pointerValue.key);check(object,'DELETION_JOURNAL_GAP');const text=await object.text();check(createHash('sha256').update(text).digest('hex')===pointerValue.hash,'DELETION_JOURNAL_HASH_MISMATCH');
    const batch=batchSchema.parse(JSON.parse(text));check(batch.generation===control.generation&&BigInt(batch.to)===expected&&BigInt(batch.from)+BigInt(batch.events.length)-1n===expected,'DELETION_JOURNAL_GAP');
    for(let i=0;i<batch.events.length;i++){
     const event=batch.events[i];check(BigInt(event.sequence)===BigInt(batch.from)+BigInt(i),'DELETION_JOURNAL_GAP');
     if(BigInt(event.sequence)>BigInt(ticket.journal.sequence)){
      if(event.decision.action==='delete'&&event.decision.kind==='members'&&event.decision.id===c.id)memberJournaled=true;
      if(event.decision.action==='media_object'&&typeof event.decision.key==='string')mediaJournaled.delete(event.decision.key);
     }
    }
    if((memberJournaled&&!mediaJournaled.size)||BigInt(batch.from)<=BigInt(ticket.journal.sequence))break;expected=BigInt(batch.from)-1n;pointerValue=batch.previous;
   }
   const journalVerified=memberJournaled&&!mediaJournaled.size;check(journalVerified,'DELETION_EXTERNAL_JOURNAL_MARKER_MISSING');
   const identityComplete=identities[0].completed_at!==null&&Number(authPending.count)===0,delayedPassComplete=finalOutboxComplete(rows,ticket);
   const complete=!!receipt&&absent&&identityComplete&&delayedPassComplete;
   stage='STATUS_RETAINED_BACKUP_METADATA';
   const [retained]=await db`select count(distinct r.id)::int as snapshots,max(r.expires_at) as retention_until from app.media_backup_items i join app.media_backup_runs r on r.id=i.run_id where r.completed_at is not null and r.expires_at>now() and i.object_key in(select jsonb_array_elements_text(${db.json(ticket.media.map(m=>m.object_key))}::jsonb))`;
   const retainedBackupSnapshots=Number(retained.snapshots),latestBackupExpiry=retained.retention_until?new Date(retained.retention_until).toISOString():null;
   const minimumCleanupAttempts=Math.min(...rows.map(row=>row.attempts)),minimumFinalPassAgeSeconds=delayedPassComplete?Math.floor(Math.min(...rows.map(row=>Date.parse(row.completed_at!)-Date.parse(row.created_at)))/1000):null;
   const result={v:1,synthetic:true,checkedAt:new Date().toISOString(),ticketSHA256:hash,acknowledged:!!receipt,sessionsRevoked,loginDenied:true,databaseErased:true,protectedAccountsIntact:true,journalVerified,identityComplete,mediaAbsent:absent,delayedPassComplete,complete,mediaObjects:ticket.media.length,minimumCleanupAttempts,minimumFinalPassAgeSeconds,retainedBackupSnapshots,latestBackupExpiry};
   if(!(await optionalPrivate(directory+'account-deletion-c.first-status.json')))await writePrivate(directory+'account-deletion-c.first-status.json',result,true);
   await writePrivate(directory+'account-deletion-c.status.json',result);
   if(complete){const latest=await readPrivate<DeletionState>(directory+'state.json');check(latest.run===state.run&&syntheticC(latest,true).id===c.id,'DELETION_STATE_CHANGED');latest.accounts[2].deleted=true;await writePrivate(directory+'state.json',latest);}
   fixedOutput({acknowledged:!!receipt,sessionsRevoked,databaseErased:true,protectedAccountsIntact:true,journalVerified,identityComplete,mediaAbsent:absent,delayedPassComplete,complete,mediaObjects:ticket.media.length,minimumCleanupAttempts,minimumFinalPassAgeSeconds,retainedBackupSnapshots,latestBackupExpiry});
  }
 }
}catch(error){console.error(JSON.stringify({phase,...deletionFailure(error,stage)}));process.exitCode=1;}
finally{for(const api of transientClients)try{await api.request('/api/auth/sign-out','POST',{});}catch{}await sql?.end({timeout:1});}
