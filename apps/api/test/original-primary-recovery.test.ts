import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import postgres,{type Sql} from 'postgres';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {initializePrivacyJournal,readJournalControl,checkpointJournal,sha256,assertJournalReadable,type JournalStore,type JournalDatabase} from '../src/privacy-journal';
import {recoverOriginalPrimary,inspectOriginalPrimaryState,originalPrimaryRecoveryTicketSchema,type OriginalPrimaryRecoveryTicket} from '../src/restore-journal';
import {originalPrimaryRecoveryArguments,validateOriginalPrimaryConfiguration} from '../../../scripts/original-primary-recovery-config';

class MemoryStore implements JournalStore{
 rows=new Map<string,{etag:string;text:string}>();serial=0;failCas=false;loseCasResponse=false;failReadAfterActive=false;onReceipt?:()=>void;
 async get(key:string){const row=this.rows.get(key);if(key==='control.json'&&this.failReadAfterActive&&row&&JSON.parse(row.text).mode==='active')throw Error('read unavailable');return row?{etag:row.etag,text:async()=>row.text}:null;}
 async put(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}){
  const row=this.rows.get(key),condition=options?.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&row||condition?.etagMatches&&condition.etagMatches!==row?.etag)return null;
  const releasing=key==='control.json'&&JSON.parse(text).mode==='active';
  if(releasing&&this.failCas){this.failCas=false;return null;}
  const etag=String(++this.serial);this.rows.set(key,{etag,text});
  if(key.startsWith('receipts/'))this.onReceipt?.();
  if(releasing&&this.loseCasResponse)throw Error('response lost');
  return {etag};
 }
}

const source={organization:'andykonwinski',name:'porchday-staging',branch:'main' as const,branchId:'oha68ugb1ahm',reviewedCommit:'a'.repeat(40)};
const sourceFor=(environment:'staging'|'production')=>environment==='staging'?source:{...source,name:'porchday-production',branchId:'synthetic-production-branch'};
const evidence={providerBranchReviewed:true,noRestore:true,writersDrained:true};
function testDatabaseUrl(branch=source.branchId,hostname='sample.pg.psdb.cloud'){
 const url=new URL('postgres://sample.pg.psdb.cloud:5432/postgres');url.username='operator.'+branch;url.password='synthetic';url.hostname=hostname;return url.href;
}
async function makeTicket(control:any,status:any,capabilitiesSha256:string,environment:'staging'|'production'='staging'):Promise<OriginalPrimaryRecoveryTicket>{
 return originalPrimaryRecoveryTicketSchema.parse({v:1,kind:'porchday-original-primary-recovery',id:randomUUID(),environment,source:sourceFor(environment),
  journalBucket:'porchday-'+environment+'-recovery-journal',mediaBucket:'porchday-'+environment+'-media',reviewedAt:new Date().toISOString(),writersDrainedAt:new Date(Date.now()-180_000).toISOString(),
  unrestoredPrimaryConfirmed:true,noRestoreOrRoutingChangeConfirmed:true,writersDrained:true,evidenceSha256:await sha256(JSON.stringify(evidence)),
  initialControl:control,initialControlSha256:await sha256(JSON.stringify(control)),initialSql:status,capabilitiesSha256});
}

describe('Original-primary operator configuration',()=>{
 it('requires an explicit single environment with the run, ticket and evidence arguments',()=>{
  const common=['--run','--ticket=private-ticket.json','--evidence=private-evidence.json'];
  for(const environment of ['staging','production'])expect(originalPrimaryRecoveryArguments([...common,'--environment='+environment])).toEqual({environment,ticketPath:'private-ticket.json',evidencePath:'private-evidence.json'});
  for(const args of [common,[...common,'--environment='],[...common,'--environment=preview'],[...common,'--environment=production','--environment=staging'],
   ['--ticket=private-ticket.json','--evidence=private-evidence.json','--environment=production'],[...common,'--environment=production','--unexpected'],
   ['--run','--ticket=','--evidence=private-evidence.json','--environment=production'],['--run','--ticket=private-ticket.json','--evidence=','--environment=production']])expect(()=>originalPrimaryRecoveryArguments(args)).toThrow('ORIGINAL_PRIMARY_EXPLICIT_ARGUMENTS_REQUIRED');
 });
 it.each(['staging','production'] as const)('requires exact %s source, verified TLS, reviewed clean checkout and evidence',async(environment)=>{
  const source=sourceFor(environment),other=environment==='staging'?'production':'staging';
  const generation=randomUUID(),control={v:1,generation,mode:'quarantine',sequence:'1',head:null,pending:[{id:randomUUID(),started_at:new Date(Date.now()-300_000).toISOString()}],reason:'unresolved_privacy_operation'};
  const ticket=await makeTicket(control,{generation,sequence:'1',quarantined:false},'0'.repeat(64),environment);
  const environments=Object.fromEntries((['staging','production'] as const).map(name=>{const source=sourceFor(name);return [name,{database:{organization:source.organization,name:source.name,branch:'main',branch_id:source.branchId},recovery_journal_bucket:'porchday-'+name+'-recovery-journal',bucket:'porchday-'+name+'-media'}];}));
  const input={ticket,environment,evidence,resources:{account_id:'account',environments},account:'account',bucket:ticket.journalBucket,mediaBucket:ticket.mediaBucket,databaseUrl:testDatabaseUrl(source.branchId),head:source.reviewedCommit,trackedChanges:''};
  expect(await validateOriginalPrimaryConfiguration(input)).toEqual(ticket);
  for(const patch of [{account:'other'},{bucket:'production'},{mediaBucket:ticket.journalBucket},{head:'b'.repeat(40)},{trackedChanges:' M scripts/restore-safety.ts'},{pgLocal:'true'},{evidence:{changed:true}},
   {databaseUrl:testDatabaseUrl('other')},{databaseUrl:testDatabaseUrl(source.branchId,'localhost')},
   {ticket:{...ticket,source:{...source,branchId:'other'}}},{ticket:{...ticket,environment:other}},{environment:other},{environment:''},
   {resources:{account_id:'account',environments:{[other]:environments[other]}}},
   {bucket:environments[other].recovery_journal_bucket},{mediaBucket:environments[other].bucket},{databaseUrl:testDatabaseUrl(sourceFor(other).branchId)},
   {ticket:{...ticket,source:sourceFor(other)}}])await expect(validateOriginalPrimaryConfiguration({...input,...patch})).rejects.toThrow();
 });
});

const url=process.env.JOURNAL_TEST_DATABASE_URL,suite=url?describe:describe.skip,database='porchday_original_primary_'+randomUUID().replaceAll('-','')+'_test';
let admin:Sql,sql:Sql,created=false,store:MemoryStore,db:JournalDatabase,ticket:OriginalPrimaryRecoveryTicket,member:string,mediaKey:string,mediaDigest:string;
suite('Original-primary incident recovery against real PostgreSQL',()=>{
 beforeAll(async()=>{
  const target=new URL(url!);if(!['localhost','127.0.0.1','[::1]'].includes(target.hostname)||!target.pathname.includes('test'))throw Error('DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
  target.pathname='/postgres';admin=postgres(target.href,{max:1,onnotice:()=>{}});await admin.unsafe('CREATE DATABASE '+database);created=true;
  target.pathname='/'+database;sql=postgres(target.href,{max:1,prepare:false,onnotice:()=>{}});
  for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())await sql.unsafe(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  db={async status(){return(await sql`select app.safety_status() as value`)[0].value;},async page(after){return(await sql`select app.safety_page(${after}::bigint,200) as value`)[0].value;}};
 },30000);
 afterAll(async()=>{await sql?.end();if(created)await admin.unsafe('DROP DATABASE '+database+' WITH (FORCE)');await admin?.end();});
 beforeEach(async()=>{
  await sql.unsafe('TRUNCATE app.members,public.auth_user,public.auth_verification,public.used_email_links,public.pilot_invitations,public.staff_users,app.safety_journal,app.deletion_outbox,app.identity_deletion_outbox RESTART IDENTITY CASCADE');
  await sql`update app.safety_journal_state set sequence=0,restore_quarantined=false`;
  member=randomUUID();const client=randomUUID(),post=randomUUID(),media=randomUUID();
  await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${member},now(),now())`;
  await sql`insert into public.auth_user(id,name,email,"emailVerified") values(${member},'Synthetic original',${member+'@example.test'},true)`;
  await sql`insert into public.auth_account(id,"userId","accountId","providerId",password) values(${randomUUID()},${member},${member},'credential','synthetic-password-hash')`;
  await sql`insert into public.auth_session(id,"userId",token,"expiresAt") values(${randomUUID()},${member},${randomUUID()},now()+interval '1 hour')`;
  await sql`insert into public.auth_verification(id,identifier,value,"expiresAt") values(${randomUUID()},'synthetic-email-change','synthetic-secret',now()+interval '1 hour')`;
  await sql`insert into public.pilot_invitations(token_hash,email,expires_at) values(${'f'.repeat(64)},'invite@example.test',now()+interval '1 day')`;
  await sql`insert into public.auth_email_outbox(member_id,encrypted_payload) values(${member},'synthetic-encrypted-email')`;
  await sql`insert into public.staff_users(subject,email,roles) values('synthetic-reviewer','reviewer@example.test',ARRAY['recovery'])`;
  await sql`insert into app.integration_clients(id,member_id,name,redirect_uri) values(${client},${member},'Synthetic app','https://example.test/return')`;
  await sql`insert into app.integration_grants(id,member_id,client_id,scopes,code_challenge,code_expires_at,expires_at,access_hash) values(${randomUUID()},${member},${client},ARRAY['profile:read'],'synthetic-challenge',now()+interval '1 hour',now()+interval '1 day',${'e'.repeat(64)})`;
  await sql`insert into app.posts(id,author_id,audience,envelope,epoch) values(${post},${member},'only_me','{}',1)`;
  mediaKey='media/'+member+'/'+media;mediaDigest=await sha256('synthetic-encrypted-media');
  await sql`insert into app.media_assets(id,owner_id,post_id,object_key,envelope,byte_size,state,envelope_sha256,raw_sha256) values(${media},${member},${post},${mediaKey},'{}',25,'attached',${mediaDigest},${mediaDigest})`;
  await sql`select app.append_safety_decision(${sql.json({action:'test_original_primary'})})`;
  store=new MemoryStore();await initializePrivacyJournal(store,db);
  const control=(await readJournalControl(store)).value;control.reason='unresolved_privacy_operation';control.pending=[{id:randomUUID(),started_at:new Date(Date.now()-300_000).toISOString()}];
  await store.put('control.json',JSON.stringify(control));const state=await inspectOriginalPrimaryState(sql);
  ticket=await makeTicket(control,state.status,state.capabilities.sha256);
 });
 const verifyMedia=async(item:{key:string;sha256:string;byteSize:number})=>{expect(item).toEqual({key:mediaKey,sha256:mediaDigest,byteSize:25});};
 const mode=()=>JSON.parse(store.rows.get('control.json')!.text).mode;
 it.each(['staging','production'] as const)('preserves existing member/session/email/integration/staff rows and actual media metadata for a %s ticket',async(environment)=>{
  const before=await inspectOriginalPrimaryState(sql);expect(before.cleanupBlocked).toBe(false);
  ticket=await makeTicket((await readJournalControl(store)).value,before.status,before.capabilities.sha256,environment);
  const result=await recoverOriginalPrimary(store,sql,ticket,verifyMedia);
  expect(result).toMatchObject({recovered:true,resolvedIntents:1,verifiedMedia:1});
  expect(result.capabilitiesBefore).toEqual(result.capabilitiesAfter);expect(await inspectOriginalPrimaryState(sql)).toEqual(before);
  expect(before.capabilities.tables.find(row=>row.table==='public.auth_session')?.count).toBe(1);expect(before.capabilities.tables.find(row=>row.table==='app.integration_grants')?.count).toBe(1);
  expect((await readJournalControl(store)).value.pending).toEqual([]);await expect(assertJournalReadable(store,db)).resolves.toBeDefined();
  const receipt=JSON.parse(store.rows.get('receipts/'+ticket.initialControl.pending[0].id+'.json')!.text);expect(receipt).toMatchObject({operator_verified_original:true,recovery_ticket_sha256:result.ticketSha256,source:ticket.source});
 });
 it('refuses wrong reason, local quarantine, database tail and stale/incomplete operator evidence',async()=>{
  for(const bad of [
   {...ticket,initialControl:{...ticket.initialControl,reason:'operator_restore'}},
   {...ticket,initialSql:{...ticket.initialSql,sequence:String(BigInt(ticket.initialSql.sequence)+1n)}},
   {...ticket,initialControlSha256:'0'.repeat(64)},
   {...ticket,writersDrainedAt:new Date().toISOString()},
   {...ticket,reviewedAt:new Date(Date.now()-31*60_000).toISOString()},
   {...ticket,unrestoredPrimaryConfirmed:false},
  ])await expect(recoverOriginalPrimary(store,sql,bad,verifyMedia)).rejects.toThrow();
  await sql`update app.safety_journal_state set restore_quarantined=true`;
  await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('ORIGINAL_PRIMARY_DATABASE_CHANGED');expect(mode()).toBe('quarantine');
 });
 it('refuses changed capabilities and database rollback without modifying independent control',async()=>{
  await sql`update public.auth_session set token=${randomUUID()}`;
  await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('ORIGINAL_PRIMARY_CAPABILITIES_CHANGED');
  await sql`update app.safety_journal_state set sequence=sequence-1`;
  await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('ORIGINAL_PRIMARY_DATABASE_CHANGED');expect(mode()).toBe('quarantine');
 });
 it('refuses expired social content and deletion work with an otherwise current ticket',async()=>{
  await sql`insert into app.posts(id,author_id,audience,envelope,epoch,expires_at,created_at) values(${randomUUID()},${member},'only_me','{}',1,now()-interval '1 hour',now()-interval '1 day')`;
  // Import the newly committed deadline into the test's independent baseline;
  // recovery itself must not perform this cleanup or any SQL mutation.
  await checkpointJournal(store,db,true);const changed=await inspectOriginalPrimaryState(sql);
  ticket=await makeTicket((await readJournalControl(store)).value,changed.status,changed.capabilities.sha256);
  await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('RESTORE_CLEANUP_INCOMPLETE');expect(mode()).toBe('quarantine');
 });
 it('refuses pending identity deletion without purging the still-present account or capabilities',async()=>{
  await sql`insert into app.identity_deletion_outbox(member_id) values(${member})`;
  await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('RESTORE_CLEANUP_INCOMPLETE');
  expect((await sql`select count(*)::int n from public.auth_session`)[0].n).toBe(1);expect((await sql`select count(*)::int n from public.auth_user`)[0].n).toBe(1);expect(mode()).toBe('quarantine');
 });
 it('refuses a capability change during media verification before publishing any receipt',async()=>{
  await expect(recoverOriginalPrimary(store,sql,ticket,async item=>{await verifyMedia(item);await sql`update public.auth_session set token=${randomUUID()}`;})).rejects.toThrow('ORIGINAL_PRIMARY_CAPABILITIES_CHANGED');
  expect(mode()).toBe('quarantine');expect([...store.rows.keys()].some(key=>key.startsWith('receipts/'))).toBe(false);
 });
 it('refuses missing/corrupt journal batches and unavailable media while retaining pending provenance',async()=>{
  const key=ticket.initialControl.head!.key,original=store.rows.get(key)!;store.rows.set(key,{...original,text:original.text+' '});
  await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('JOURNAL_HASH_MISMATCH');store.rows.set(key,original);
  await expect(recoverOriginalPrimary(store,sql,ticket,async()=>{throw Error('MEDIA_UNAVAILABLE');})).rejects.toThrow('MEDIA_UNAVAILABLE');
  expect((await readJournalControl(store)).value).toEqual(ticket.initialControl);expect([...store.rows.keys()].some(key=>key.startsWith('receipts/'))).toBe(false);
 });
 it('keeps pending intents on final CAS failure and accepts only the same durable receipts on an explicit retry',async()=>{
  store.failCas=true;await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('RESTORE_CHECKPOINT_CHANGED');
  expect((await readJournalControl(store)).value).toEqual(ticket.initialControl);expect([...store.rows.keys()].filter(key=>key.startsWith('receipts/'))).toHaveLength(1);
  await expect(recoverOriginalPrimary(store,sql,{...ticket,id:randomUUID()},verifyMedia)).rejects.toThrow('ORIGINAL_PRIMARY_RECEIPT_CONFLICT');
  expect((await recoverOriginalPrimary(store,sql,ticket,verifyMedia)).recovered).toBe(true);
 });
 it('does not clear an additional intent appearing during reconciliation',async()=>{
  store.onReceipt=()=>{const control=JSON.parse(store.rows.get('control.json')!.text);control.pending.push({id:randomUUID(),started_at:new Date().toISOString()});store.rows.set('control.json',{etag:'concurrent',text:JSON.stringify(control)});};
  await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('RESTORE_CHECKPOINT_CHANGED');
  expect((await readJournalControl(store)).value.pending).toHaveLength(2);expect(mode()).toBe('quarantine');
 });
 it('reports a committed CAS with lost acknowledgement as unconfirmed and never retries it',async()=>{
  store.loseCasResponse=true;await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('ORIGINAL_PRIMARY_RELEASE_UNCONFIRMED');
  expect(mode()).toBe('active');store.loseCasResponse=false;
  await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('RESTORE_CHECKPOINT_CHANGED');
 });
 it('reports unavailable final readback as unconfirmed',async()=>{
  store.failReadAfterActive=true;await expect(recoverOriginalPrimary(store,sql,ticket,verifyMedia)).rejects.toThrow('ORIGINAL_PRIMARY_RELEASE_UNCONFIRMED');expect(mode()).toBe('active');
 });
});
