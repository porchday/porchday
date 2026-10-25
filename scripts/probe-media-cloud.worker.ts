// Dedicated synthetic-only probe bundle. Never used by ordinary operator deployments.
import {Hono} from 'hono';
import productionWorker,{app as productionApp} from '../apps/api/src/index.js';
import {registerMediaRoutes} from '../apps/api/src/social-media.js';
import {beginMediaBackup,copyMediaBackupPage,verifyMediaBackup,type BackupDatabase} from '../apps/api/src/media-backup.js';
import {initializePrivacyJournal,readJournalControl,type JournalStore} from '../apps/api/src/privacy-journal.js';
import operator from './r2-operator-worker.mjs';
import type {Env,Variables} from '../apps/api/src/types.js';
const fixtureKey='probes/media-fixture.json',rowKey='probes/media-row.json';
async function trace(env:any,phase:string){if(env.PROBE_TRACE)await env.JOURNAL.put('probes/media-phase.json',JSON.stringify({phase,at:new Date().toISOString()}));}
class ProbeError extends Error{constructor(readonly code:string,readonly status=400){super(code);}}
const fail=(code:string,status=400):never=>{throw new ProbeError(code,status);};
async function fixture(env:any){const object=await env.JOURNAL.get(fixtureKey);if(!object)fail('PROBE_NOT_INITIALIZED');return object!.json() as Promise<any>;}
async function transaction(c:any,work:(db:any)=>Promise<any>){
 // This deliberately emulates only the media statements used by the real handler.
 // It is not a database/RLS/authentication test, and never opens a SQL connection.
 const db:any=async(parts:TemplateStringsArray,...values:any[])=>{
  const statement=parts.join('?').replace(/\s+/g,' ').trim(),kind=statement.startsWith('update app.media_assets')?'ready_update':statement.startsWith('select id from app.media_assets')?'ready_select':statement.startsWith('select * from app.media_assets')?'pending_select':'other_statement';
  await trace(c.env,'fixture_'+kind+'_before_get');const object=await c.env.JOURNAL.get(rowKey),row=object?await object.json():null;await trace(c.env,'fixture_'+kind+'_after_get');
  if(statement.startsWith('select member_id from app.profiles'))return[{member_id:c.get('memberId')}];
  if(statement.startsWith('select coalesce(sum(byte_size)'))return[{bytes:row?.byte_size??0}];
  if(statement.startsWith('insert into app.media_assets')){if(row)fail('PROBE_DUPLICATE',409);const[id,owner_id,object_key,envelope,envelope_sha256,byte_size]=values;await c.env.JOURNAL.put(rowKey,JSON.stringify({id,owner_id,object_key,envelope,envelope_sha256,byte_size,state:'pending'}));return[];}
  if(statement.startsWith('select * from app.media_assets'))return row?.id===values[0]&&row.owner_id===values[1]&&row.state==='pending'?[row]:[];
  if(statement.startsWith('select id from app.media_assets'))return row?.id===values[0]&&row.owner_id===values[1]&&row.object_key===values[2]&&row.envelope_sha256===values[3]&&row.state==='pending'?[{id:row.id}]:[];
  if(statement.startsWith("update app.media_assets set state='ready'")){if(row?.id!==values[1])fail('PROBE_ROW_MISSING');await trace(c.env,'fixture_ready_before_put');await c.env.JOURNAL.put(rowKey,JSON.stringify({...row,state:'ready',raw_sha256:values[0]}));await trace(c.env,'fixture_ready_after_put');return[];}
  if(statement.startsWith('select app.lock_media_upload_cleanup'))return[{state:row?.id===values[0]?row.state:'unavailable'}];
  fail('PROBE_UNEXPECTED_SQL',503);
 };db.json=(value:unknown)=>value;return work(db);
}
const media=new Hono<{Bindings:Env;Variables:Variables}>();
media.onError((error,c)=>c.json({error:error instanceof ProbeError?error.code:'PROBE_HANDLER_FAILED'},(error instanceof ProbeError?error.status:503) as any));
media.use('*',async(c,next)=>{const value=await fixture(c.env);c.set('memberId',value.member);c.set('authTime',Date.now());await next();});
registerMediaRoutes(media,{tx:transaction,body:async(c,schema)=>schema.parse(await c.req.json()),fail,id:raw=>{if(!raw||!/^[a-f0-9-]{36}$/.test(raw))fail('PROBE_ID_INVALID');return raw!;},writeAllowed:async()=>{},checkEnvelope:async(_db,member,envelope,kind)=>{if(envelope.context.authorId!==member||envelope.context.kind!==kind||envelope.recipients.length!==1)fail('PROBE_CONTEXT_INVALID');}});
async function mediaRequest(request:Request,env:any,path:string){
 const current=await fixture(env);if(current.trace){const source=env.MEDIA,diagnosticEnv={...env,PROBE_TRACE:true};env={...diagnosticEnv,MEDIA:Object.fromEntries(['put','get','head','delete'].map(method=>[method,async(...args:any[])=>{await trace(diagnosticEnv,'media_'+method+'_start');const result=await source[method](...args);await trace(diagnosticEnv,'media_'+method+'_complete');return result;}]))};}
 return media.fetch(new Request('https://synthetic.invalid'+path,request),env);
}
export default {async fetch(request:Request,env:any){
 // The full production app instance is retained and constructed, but no app route is reachable.
 const footprint=productionApp.routes.length;
 if(!env.OPERATOR_BEARER||request.headers.get('Authorization')!=='Bearer '+env.OPERATOR_BEARER||!Number.isFinite(Number(env.OPERATOR_EXPIRES_AT))||Date.now()>=Number(env.OPERATOR_EXPIRES_AT))return new Response(null,{status:401});
 const path=new URL(request.url).pathname;
 if(!path.startsWith('/probe/')||path==='/probe/delete')return operator.fetch(request,env);
 try{
  if(path==='/probe/init'){
   const raw=await request.text();if(raw.length>20000)fail('PROBE_INIT_TOO_LARGE');const value=JSON.parse(raw);
   if(!/^[a-f0-9-]{36}$/.test(value.member)||!Array.isArray(value.items)||value.items.length!==8||value.items.some((i:any)=>i.byte_size!==22020096||!/^[a-f0-9]{64}$/.test(i.sha256)||!/^[a-f0-9]{64}$/.test(i.canonical_sha256)||!new RegExp('^media/'+value.member+'/[a-f0-9-]{36}$').test(i.object_key)))fail('PROBE_INIT_INVALID');
   await env.JOURNAL.put(fixtureKey,JSON.stringify(value));return Response.json({initialized:true,productionRoutesLoaded:footprint,productionEntrypointsLoaded:Object.keys(productionWorker),syntheticDatabase:true});
  }
  if(path==='/probe/cleanup'){
   let deleted=0;for(const bucket of[env.MEDIA,env.BACKUP,env.JOURNAL]){for(;;){const page=await bucket.list({limit:100});if(!page.objects.length)break;await bucket.delete(page.objects.map((o:any)=>o.key));deleted+=page.objects.length;}}
   return Response.json({deleted,empty:true});
  }
  if(path==='/probe/diagnostics'){const object=await env.JOURNAL.get('probes/media-phase.json');return Response.json(object?await object.json():{});}
  if(path==='/probe/reserve'&&request.method==='POST')return mediaRequest(request,env,'/media');
  if(path==='/probe/reserve-overlap'){
   if(request.method!=='POST'||!request.body)fail('PROBE_REQUEST_INVALID');const [a,b]=request.body.tee();
   const run=async(body:ReadableStream<Uint8Array>)=>{const response=await mediaRequest(new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body}),env,'/media');if(response.status===429)void body.cancel().catch(()=>{});return {status:response.status,retryAfter:response.headers.get('Retry-After'),value:await response.json()};};
   const results=await Promise.all([run(a),run(b)]);if(results.map(r=>r.status).sort().join(',')!=='201,429'||results.find(r=>r.status===429)?.retryAfter!=='1')fail('PROBE_OVERLAP_FAILED',503);return Response.json({results});
  }
  const current=await fixture(env);
  if(path==='/probe/reset-media'){
   await env.MEDIA.delete('media/'+current.member+'/'+current.mediaId);await env.JOURNAL.delete(rowKey);return Response.json({reset:true});
  }
  if(path==='/probe/upload'&&request.method==='PUT')return mediaRequest(request,env,'/media/'+current.mediaId+'/bytes');
  if(path==='/probe/adversarial-check'){
   const row=await(await env.JOURNAL.get(rowKey)).json();if(row.state!=='pending'||await env.MEDIA.head('media/'+current.member+'/'+current.mediaId))fail('PROBE_INVALID_UPLOAD_RETAINED');return Response.json({pending:true,temporaryObjectRemoved:true});
  }
  const database:BackupDatabase={journal:{async status(){return{generation:current.run.generation,sequence:'0',quarantined:false};},async page(){return[];}},async start(){return current.run;},async info(){return current.run;},async page(_,cursor){return current.items.filter((i:any)=>i.object_key>(cursor??'')).slice(0,8);},async missing(){return null;},async complete(){},async failed(){}};
  const storage={source:env.MEDIA,backup:env.BACKUP,journal:env.JOURNAL as JournalStore,db:database};
  if(path==='/probe/upload-check'){const row=await(await env.JOURNAL.get(rowKey)).json(),item=current.items.find((i:any)=>i.object_key===row.object_key);if(row.state!=='ready'||row.raw_sha256!==item.sha256||row.envelope_sha256!==item.canonical_sha256)fail('PROBE_UPLOAD_CHECK_FAILED');return Response.json({ready:true,rawAndCanonicalHashesVerified:true});}
  if(path==='/probe/backup-start'){
   const sourceKey='media/'+current.member+'/'+current.mediaId;
   for(const item of current.items)if(item.object_key!==sourceKey){const source=await env.MEDIA.get(sourceKey);await env.MEDIA.put(item.object_key,source.body,{onlyIf:{etagDoesNotMatch:'*'},sha256:item.sha256});}
   await initializePrivacyJournal(storage.journal,database.journal);const control=await readJournalControl(storage.journal);await storage.journal.put('control.json',JSON.stringify({...control.value,mode:'active',reason:null}),{onlyIf:{etagMatches:control.etag}});return Response.json({id:await beginMediaBackup(storage)});
  }
  if(path==='/probe/backup-page')return Response.json({status:await copyMediaBackupPage(storage,current.run.id)});
  if(path==='/probe/backup-check'){const result=await verifyMediaBackup(env.BACKUP,current.run.id,current.run.restore_at);return Response.json({objects:result.objects,bytes:result.bytes});}
  fail('PROBE_NOT_FOUND',404);
 }catch(error){return Response.json({error:error instanceof ProbeError?error.code:'PROBE_FAILED'},{status:error instanceof ProbeError?error.status:503});}
}};
