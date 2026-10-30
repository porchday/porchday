/** Owned drill child only. Connection arrives over private IPC, never arguments.
 * No receipt/checkpoint completion path exists here: parent verifies COMMIT and
 * kills the parked child. Do not import this entrypoint into the application. */
import {readFileSync} from 'node:fs';
import {URL} from 'node:url';
import postgres from 'postgres';
import {z} from 'zod';
import {beginPrivacyIntent,publishAuthPrivacyCommitScope,type JournalDatabase} from '../apps/api/src/privacy-journal';
import {createCommitDrillClient} from './commit-drill-ipc';
import {commitDrillFixtureSchema,commitDrillSession} from './commit-drill-transaction';

const initSchema=z.object({type:z.literal('init'),target:z.enum(['staging','local-test']),connection:z.string().max(4096),fixture:commitDrillFixtureSchema}).strict();
if(!process.send)throw Error('DRILL_PRIVATE_IPC_REQUIRED');
const send=(value:unknown)=>new Promise<void>((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error('DRILL_IPC_SEND_TIMEOUT')),5000);
 try{process.send!(value as never,error=>{clearTimeout(timer);error?reject(Error('DRILL_IPC_SEND_FAILED')):resolve();});}catch{clearTimeout(timer);reject(Error('DRILL_IPC_SEND_FAILED'));}
});
process.once('message',async input=>{
 let sql:ReturnType<typeof postgres>|undefined,client:ReturnType<typeof createCommitDrillClient>|undefined;
 try{
  const init=initSchema.parse(input),url=new URL(init.connection);
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.username||!url.password||url.search||url.hash)throw Error('DRILL_DATABASE_TARGET');
  if(init.target==='local-test'){
   if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/porchday_commit_proof_test')throw Error('DRILL_LOCAL_DATABASE_REQUIRED');
  }else{
   const resources=JSON.parse(readFileSync(new URL('../infra/resources.json',import.meta.url),'utf8')),branch=resources.environments.staging.database.branch_id;
   if(typeof branch!=='string'||!branch||!url.hostname.endsWith('.pg.psdb.cloud')||url.port!=='5432'||!decodeURIComponent(url.username).endsWith('.'+branch))throw Error('DRILL_STAGING_DATABASE_REQUIRED');
  }
  client=createCommitDrillClient({send:message=>{if(!process.send!(message as never))throw Error('DRILL_IPC_BACKPRESSURE');},subscribe:receive=>{
   const listener=(message:unknown)=>{if(message&&typeof message==='object'&&(message as {type?:unknown}).type==='journal-result')receive(message);};process.on('message',listener);return()=>{process.off('message',listener);};
  }});
  sql=postgres(init.connection,{max:1,prepare:false,fetch_types:false,connect_timeout:5,...(init.target==='staging'?{ssl:'verify-full' as const}:{}),onnotice:()=>{}});
  // Verify role assumption and exact session ownership before registering an intent.
  const {commitDrillIdentity}=await import('./commit-drill-transaction');const identity=commitDrillIdentity(init.fixture);
  await sql.begin('read only',async tx=>{
   await tx`set local statement_timeout='5s'`;await tx`set local transaction_timeout='15s'`;await tx`set local role porchday_auth`;
   const rows=await tx`select s.id from public.auth_session s join public.auth_user u on u.id=s."userId" where s.id=${init.fixture.sessionId} and u.id=${init.fixture.memberId} and u.email=${identity.email} and u.name=${identity.name}`;
   if(rows.length!==1)throw Error('DRILL_FIXTURE_UNVERIFIED');
  });
  const db:JournalDatabase={
   async status(){return sql!.begin('read only',async tx=>{await tx`set local statement_timeout='5s'`;await tx`set local transaction_timeout='15s'`;return(await tx`select app.safety_status() as value`)[0].value;});},
   async page(after){return sql!.begin('read only',async tx=>{await tx`set local statement_timeout='5s'`;await tx`set local transaction_timeout='15s'`;return(await tx`select app.safety_page(${after}::bigint,200) as value`)[0].value;});},
  };
  const intent=await beginPrivacyIntent(client.store,db);await send({type:'phase',phase:'registered',operationId:intent.id});
  const scope=await publishAuthPrivacyCommitScope(client.store,db,intent);await send({type:'phase',phase:'scoped',...scope});
  const committed=await commitDrillSession(sql,init.fixture,scope);await sql.end({timeout:1});sql=undefined;
  await send({type:'phase',phase:'committed',...committed});
  // IPC remains open; no subsequent SQL, R2 write, receipt or cleanup is issued.
  await new Promise(()=>{});
 }catch{
  client?.close();await sql?.end({timeout:1}).catch(()=>{});await send({type:'phase',phase:'failed',code:'DRILL_CHILD_RECONCILIATION_REQUIRED'}).catch(()=>{});
  process.exitCode=1;process.disconnect?.();
 }
});
