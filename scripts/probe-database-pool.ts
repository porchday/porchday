/** Read-only staging compatibility probe. No member rows or provider errors are emitted. */
import postgres from 'postgres';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export function pooledTarget(value:string|undefined,branchId:string){
 if(!value||!branchId)throw Error('POOL_PROBE_CONFIGURATION_REQUIRED');
 let url:URL;try{url=new URL(value);}catch{throw Error('POOL_PROBE_TARGET_MISMATCH');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname.endsWith('.pg.psdb.cloud')||url.port!=='5432'
  ||!decodeURIComponent(url.username).endsWith('.'+branchId)||!url.password)throw Error('POOL_PROBE_TARGET_MISMATCH');
 url.port='6432';return url.href;
}

export async function probePool(connection:string){
 const sql=postgres(connection,{max:1,prepare:true,fetch_types:false,ssl:'verify-full',connect_timeout:5,onnotice:()=>{}});
 try{
  const actors=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
  const started=performance.now();
  for(const actor of actors){
   await sql.begin('read only',async tx=>{
    await tx`set local statement_timeout='5s'`;
    const [before]=await tx`select current_setting('app.member_id',true) as actor,current_setting('transaction_read_only') as read_only`;
    if(before.actor||before.read_only!=='on')throw Error('POOL_PROBE_TRANSACTION_ISOLATION_FAILED');
    await tx`select set_config('app.member_id',${actor},true)`;
    // Reuse an actual parameterized prepared statement across transactions.
    for(let i=0;i<3;i++){
     const [row]=await tx`select current_setting('app.member_id',true) as actor,${i}::int as value`;
     if(row.actor!==actor||row.value!==i)throw Error('POOL_PROBE_PREPARED_STATEMENT_FAILED');
    }
   });
  }
  await sql.begin('read only',async tx=>{
   await tx`set local statement_timeout='5s'`;
   const [row]=await tx`select current_setting('app.member_id',true) as actor`;
   if(row.actor)throw Error('POOL_PROBE_TRANSACTION_ISOLATION_FAILED');
  });
  return {transactions:3,preparedReads:6,transactionIdentityCleared:true,elapsedMs:Math.round(performance.now()-started)};
 }finally{await sql.end({timeout:1});}
}

export async function probeAuthPool(connection:string){
 const target=new URL(connection);
 // node-postgres parses URL SSL options after its explicit configuration.
 // Remove those options so this probe always verifies the certificate.
 for(const key of ['sslmode','sslcert','sslkey','sslrootcert','ssl'])target.searchParams.delete(key);
 const pool=new pg.Pool({connectionString:target.href,max:1,connectionTimeoutMillis:5000,ssl:{rejectUnauthorized:true}});
 try{
  const client=await pool.connect();
  try{
   for(const actor of ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']){
    await client.query('BEGIN READ ONLY');
    try{
     await client.query("SET LOCAL statement_timeout='5s'");
     const before=await client.query("SELECT current_setting('app.member_id',true) AS actor");
     if(before.rows[0].actor)throw Error('POOL_PROBE_TRANSACTION_ISOLATION_FAILED');
     await client.query("SELECT set_config('app.member_id',$1,true)",[actor]);
     const result=await client.query({name:'porchday-pool-read-only-probe',text:"SELECT current_setting('app.member_id',true) AS actor, $1::int AS value",values:[7]});
     if(result.rows[0].actor!==actor||result.rows[0].value!==7)throw Error('POOL_PROBE_PREPARED_STATEMENT_FAILED');
     await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
   }
   const final=await client.query("SELECT current_setting('app.member_id',true) AS actor");
   if(final.rows[0].actor)throw Error('POOL_PROBE_TRANSACTION_ISOLATION_FAILED');
   return {transactions:2,preparedReads:2,transactionIdentityCleared:true};
  }finally{client.release();}
 }finally{await pool.end();}
}

async function main(){
 try{
  if(process.argv.length!==4||process.argv[2]!=='staging'||process.argv[3]!=='--run')throw Error('USE_POOL_PROBE_STAGING_RUN');
  const resources=JSON.parse(await readFile(new URL('../infra/resources.json',import.meta.url),'utf8'));
  const configured=resources.environments.staging;
  if(configured.database.name!=='porchday-staging')throw Error('POOL_PROBE_TARGET_MISMATCH');
  const results=[];
  for(const role of ['auth','social','jobs']){
   const target=pooledTarget(process.env['PORCHDAY_STAGING_DATABASE_'+role.toUpperCase()+'_URL'],configured.database.branch_id);
   results.push({role,driver:'postgres',...await probePool(target)});
   if(role==='auth')results.push({role,driver:'pg',...await probeAuthPool(target)});
  }
  console.log(JSON.stringify({at:new Date().toISOString(),environment:'staging',port:6432,readOnly:true,results,
   limitations:'Direct driver compatibility only; not Hyperdrive, saturation, failover, or application acceptance.'}));
 }catch(error){
  const code=(error as Error).message;
  console.error(/^POOL_PROBE_[A-Z_]+$|^USE_POOL_PROBE_STAGING_RUN$/.test(code)?code:'POOL_PROBE_UNAVAILABLE');process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
