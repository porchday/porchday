/** Disposable local destination: shipped Worker, real PostgreSQL/R2 and captured email transport. */
import {build} from 'esbuild';
import {builtinModules} from 'node:module';
import {createServer} from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,readdir,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import postgres,{type Sql} from 'postgres';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {initializePrivacyJournal,readJournalControl,assertJournalReadable,type JournalStore,type JournalDatabase} from '../apps/api/src/privacy-journal.js';
import {check} from './hosted-smoke-support.js';

export function localOrigin(value:string){
 const url=new URL(value);check(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&/^\d{4,5}$/.test(url.port)&&
  Number(url.port)>=1024&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash,'ISOLATED_LOCAL_ORIGIN_REQUIRED');return url.origin;
}
export function localVerificationLink(message:{to:string;text:string},email:string,origin:string){
 check(message.to===email&&message.text.length<=12000,'LOCAL_MAIL_RECIPIENT_REQUIRED');
 const candidates=message.text.match(/https?:\/\/[^\s]+/g)||[];
 const links=candidates.map(value=>new URL(value)).filter(url=>url.origin===localOrigin(origin)&&url.pathname==='/api/auth/verify-email');
 check(links.length===1&&links[0].searchParams.has('token')&&!links[0].username&&!links[0].password&&!links[0].hash,'LOCAL_VERIFICATION_LINK_REQUIRED');
 const callback=links[0].searchParams.get('callbackURL');
 if(callback)check(new URL(callback,origin).origin===origin&&new URL(callback,origin).pathname==='/login','LOCAL_VERIFICATION_CALLBACK_REQUIRED');
 return links[0].href;
}
async function freePort(){return new Promise<number>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=(server.address() as {port:number}).port;server.close(error=>error?reject(error):resolve(port));});});}
export async function createArchiveDestination(attempt:string){
 check(/^[a-f0-9]{8}$/.test(attempt),'LOCAL_ARCHIVE_ATTEMPT_REQUIRED');
 const adminURL='postgres://postgres:porchday-local@127.0.0.1:54329/postgres',name='porchday_archive_'+attempt;
 const admin=postgres(adminURL,{max:1,prepare:false,onnotice:()=>{}}),roles:string[]=[];
 let sql:Sql|undefined,mf:Miniflare|undefined,created=false,directory:string|undefined,closed=false,stage='create_database';
 const email=`archive_${attempt}@example.test`,handle=`archive_${attempt}`,password=randomBytes(36).toString('base64url'),invite=randomBytes(32).toString('base64url');
 const messages:{to:string;subject:string;text:string}[]=[];
 async function cleanup(){
  if(closed)return;let failed=false;
  if(mf)try{await mf.dispose();}catch{failed=true;}
  if(sql)try{await sql.end({timeout:10});}catch{failed=true;}
  if(created){try{
   let idle=false;for(let n=0;n<200;n++){const rows=await admin`select count(*)::int n from pg_stat_activity where datname=${name}`;if(rows[0].n===0){idle=true;break;}await new Promise(r=>setTimeout(r,25));}
   check(idle,'LOCAL_ARCHIVE_DATABASE_BUSY');await admin.unsafe('DROP DATABASE '+name);created=false;
  }catch{failed=true;}}
  if(!created)for(const role of roles)try{await admin.unsafe('DROP ROLE '+role);}catch{failed=true;}
  if(!failed&&directory)try{await rm(directory,{recursive:true,force:false});}catch{failed=true;}
  await admin.end({timeout:10});closed=true;check(!failed,'LOCAL_ARCHIVE_TEARDOWN_UNCONFIRMED');
 }
 try{
  await admin.unsafe('CREATE DATABASE '+name);created=true;
  const owner=new URL(adminURL);owner.pathname='/'+name;sql=postgres(owner.toString(),{max:1,prepare:false,onnotice:()=>{}});
  const migrations=(await readdir(resolve('apps/api/migrations'))).filter(n=>/^\d{3}_.+\.sql$/.test(n)).sort();
  for(const file of migrations){stage='migration_'+file.slice(0,3);const source=await readFile(resolve('apps/api/migrations',file),'utf8');await sql.begin(tx=>tx.unsafe(source));}
  stage='roles';const hyperdrives:Record<string,string>={};
  for(const kind of ['auth','social','jobs']){
   const role=`archive_${attempt}_${kind}`,secret=randomBytes(30).toString('hex');
   await admin.unsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT IN ROLE porchday_${kind} PASSWORD '${secret}'`);roles.push(role);
   const url=new URL(owner);url.username=role;url.password=secret;hyperdrives['HYPERDRIVE_'+kind.toUpperCase()]=url.toString();
  }
  stage='invitation';await sql`insert into public.pilot_invitations(token_hash,email,expires_at) values(${createHash('sha256').update(invite).digest('hex')},${email},now()+interval '1 hour')`;
  directory=await mkdtemp(join(tmpdir(),'porchday-archive-'+attempt+'-'));await chmod(directory,0o700);
  const port=await freePort(),origin=localOrigin('http://127.0.0.1:'+port);
  const source=`import worker from ${JSON.stringify(resolve('apps/api/src/index.ts'))};
   function wrapped(env){return {...env,EMAIL:{async send(message){const r=await env.CAPTURE_EMAIL.fetch(new Request('http://local-email/capture',{method:'POST',body:JSON.stringify(message)}));if(r.status!==200)throw Error('LOCAL_MAIL_FAILED');return {messageId:'local-captured'};}}};}
   export default {fetch(request,env,ctx){return worker.fetch(request,wrapped(env),ctx)},queue(batch,env,ctx){return worker.queue(batch,wrapped(env),ctx)}};`;
  stage='bundle';const bundled=await build({stdin:{contents:source,resolveDir:resolve('.'),sourcefile:'archive-local.worker.ts'},bundle:true,write:false,format:'esm',platform:'neutral',mainFields:['browser','module','main'],conditions:['workerd','browser'],external:['node:*','cloudflare:*'],target:'es2022',logLevel:'silent',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire('/local-archive.js');"},plugins:[{name:'node-builtins',setup(b){b.onResolve({filter:/.*/},args=>builtinModules.includes(args.path)?{path:args.path.startsWith('node:')?args.path:'node:'+args.path,external:true}:undefined);}}]});
  stage='runtime';mf=new Miniflare(convertV4MiniflareOptions({name:'archive-local-'+attempt,modules:true,script:bundled.outputFiles[0].text,host:'127.0.0.1',port,
   compatibilityDate:'2026-10-24',compatibilityFlags:['nodejs_compat'],resourcePersistencePath:join(directory,'storage'),hyperdrives,
   log:new Log(LogLevel.NONE),logRequests:false,handleStructuredLogs:()=>{},
   bindings:{APP_URL:origin,ENVIRONMENT:'development',SIGNUP_ENABLED:'true',EMAIL_FROM:'Porchday <accounts@porchday.com>',BETTER_AUTH_SECRET:randomBytes(40).toString('base64url')},
   r2Buckets:{MEDIA:'archive-media-'+attempt,RECOVERY_JOURNAL:'archive-journal-'+attempt},queueProducers:{JOBS:'archive-jobs-'+attempt},queueConsumers:{['archive-jobs-'+attempt]:{maxBatchTimeout:1}},
   assets:{directory:resolve('apps/web/dist'),binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true},assetConfig:{not_found_handling:'single-page-application'}},
   serviceBindings:{CAPTURE_EMAIL:async request=>{if(request.method!=='POST')return new Response(null,{status:405});const message=await request.json() as {to:string;subject:string;text:string};
    if(message.to!==email||typeof message.text!=='string'||message.text.length>12000||messages.length>=8)return new Response(null,{status:400});messages.push(message);return new Response('{}',{headers:{'Content-Type':'application/json'}});}},
  }));
  await mf.ready;stage='journal';
  const journal=await mf.getR2Bucket('RECOVERY_JOURNAL') as unknown as JournalStore;
  const db:JournalDatabase={async status(){const[r]=await sql!`select app.safety_status() value`;return r.value;},async page(after){const[r]=await sql!`select app.safety_page(${after}::bigint,200) value`;return r.value;}};
  await initializePrivacyJournal(journal,db);const initial=await readJournalControl(journal),local=await db.status();
  check(initial.value.mode==='quarantine'&&initial.value.reason==='initialization'&&!initial.value.pending.length&&initial.value.generation===local.generation&&initial.value.sequence===local.sequence&&!local.quarantined,'LOCAL_INITIALIZATION_MISMATCH');
  check(await journal.put('control.json',JSON.stringify({...initial.value,mode:'active',reason:null}),{onlyIf:{etagMatches:initial.etag}}),'LOCAL_INITIALIZATION_CHANGED');await assertJournalReadable(journal,db);
  stage='health_fetch';const health=await fetch(origin+'/health',{redirect:'error',signal:AbortSignal.timeout(30000)});stage='health_status_'+health.status;const healthBody=await health.text();if(!health.ok){const labels=['ASSETS','ReferenceError','TypeError','require','service','entrypoint','asset','fetch','binding'];stage+='_'+labels.filter(word=>healthBody.includes(word)).join('_');}const healthValue=JSON.parse(healthBody) as any;check(health.ok&&healthValue.environment==='development','LOCAL_DESTINATION_HEALTH_REQUIRED');
  return {origin,email,handle,password,invite,name,migrations:migrations.length,cleanup,
   async verification(){for(let n=0;n<100;n++){const mail=messages.find(m=>m.subject==='Verify your Porchday email');if(mail)return localVerificationLink(mail,email,origin);await new Promise(r=>setTimeout(r,100));}throw Error('LOCAL_VERIFICATION_EMAIL_NOT_DELIVERED');},
   async emptyAuthIdentity(member:string){const rows=await sql!`select count(*)::int n from public.auth_user where id=${member}`;return rows[0].n===0;},
  };
 }catch(error){try{await cleanup();}catch{throw Error('LOCAL_ARCHIVE_SETUP_AND_TEARDOWN_FAILED');}throw Error('LOCAL_ARCHIVE_SETUP_'+stage.toUpperCase());}
}
