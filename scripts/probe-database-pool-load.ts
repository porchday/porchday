/** Bounded staging-only read load; no member data, writes, or production option. */
import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
import {pooledTarget} from './probe-database-pool.js';

let observer:ReturnType<typeof postgres>|undefined;
const clients:ReturnType<typeof postgres>[]=[];
try{
 if(process.argv.length!==4||process.argv[2]!=='staging'||process.argv[3]!=='--run')throw Error('POOL_LOAD_STAGING_RUN_REQUIRED');
 const resources=JSON.parse(await readFile(new URL('../infra/resources.json',import.meta.url),'utf8'));
 const branch=resources.environments.staging.database;
 if(branch.name!=='porchday-staging')throw Error('POOL_LOAD_TARGET_MISMATCH');
 const admin=process.env.PORCHDAY_STAGING_DATABASE_MIGRATION_URL;
 pooledTarget(admin,branch.branch_id); // Same branch/TLS target validation, but keep observation direct.
 observer=postgres(admin!,{max:1,prepare:false,fetch_types:false,ssl:'verify-full',connect_timeout:5,onnotice:()=>{}});
 const samples:{applicationConnections:number;totalConnections:number}[]=[];
 async function snapshot(){
  const [row]=await observer!.begin('read only',async tx=>{
   await tx`set local statement_timeout='5s'`;
   return tx`select count(*)::int as total,
    count(*) filter(where usename<>current_user and not exists(select 1 from pg_roles r where r.oid=usesysid and r.rolsuper) and (pg_has_role(usename,'porchday_auth','USAGE')
     or pg_has_role(usename,'porchday_social','USAGE') or pg_has_role(usename,'porchday_jobs','USAGE')))::int as application
    from pg_stat_activity where datname=current_database() and backend_type='client backend'`;
  });
  samples.push({applicationConnections:row.application,totalConnections:row.total});
 }
 await snapshot();
 if(samples[0].applicationConnections>12||samples[0].totalConnections>18)throw Error('POOL_LOAD_BASELINE_HEADROOM_REQUIRED');
 for(const role of ['AUTH','SOCIAL','JOBS'])for(let i=0;i<12;i++){
  const target=pooledTarget(process.env['PORCHDAY_STAGING_DATABASE_'+role+'_URL'],branch.branch_id);
  clients.push(postgres(target,{max:1,prepare:true,fetch_types:false,ssl:'verify-full',connect_timeout:5,onnotice:()=>{}}));
 }
 const started=performance.now();let finished=false;
 const operations=Promise.allSettled(clients.map(async sql=>{
  const actor=crypto.randomUUID();
  await sql.begin('read only',async tx=>{
   await tx`set local statement_timeout='2s'`;
   const [initial]=await tx`select current_setting('app.member_id',true) as actor`;
   if(initial.actor)throw Error('POOL_LOAD_IDENTITY_LEAK');
   await tx`select set_config('app.member_id',${actor},true)`;
   // Hold only the probe's own read transaction for 250ms. Thirty-six clients
   // exceed the entire server's 25 slots but must multiplex within twelve.
   await tx`select pg_sleep(0.25)`;
   const [result]=await tx`select current_setting('app.member_id',true) as actor`;
   if(result.actor!==actor)throw Error('POOL_LOAD_IDENTITY_MISMATCH');
  });
 })).finally(()=>{finished=true;});
 do{await snapshot();if(!finished)await new Promise(resolve=>setTimeout(resolve,100));}while(!finished);
 const outcomes=await operations;await snapshot();
 const passed=outcomes.filter(x=>x.status==='fulfilled').length;
 const maximum=Math.max(...samples.map(x=>x.applicationConnections));
 const result={at:new Date().toISOString(),environment:'staging',readOnly:true,clients:clients.length,passed,
  elapsedMs:Math.round(performance.now()-started),observedMaxApplicationConnections:maximum,samples,
  limitations:'Sampled direct-PgBouncer test, not an exhaustive connection bound, Hyperdrive load test, timeout/failover drill or production acceptance.'};
 console.log(JSON.stringify(result));
 if(passed!==clients.length||maximum>12)throw Error('POOL_LOAD_ACCEPTANCE_FAILED');
}catch(error){
 const code=(error as Error).message;console.error(/^POOL_(LOAD|PROBE)_[A-Z_]+$/.test(code)?code:'POOL_LOAD_UNAVAILABLE');process.exitCode=1;
}finally{await Promise.allSettled(clients.map(sql=>sql.end({timeout:1})));await observer?.end({timeout:1});}
