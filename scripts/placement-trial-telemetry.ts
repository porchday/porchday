import postgres from 'postgres';
import {validateReleaseDatabaseTarget} from './release-schema.ts';
import type {TrialConnections,TrialMetrics} from './placement-trial-collector.ts';

/** Direct, read-only, unsampled capacity observation. Counting every client
 * backend is conservative: no unverified subtraction of provider connections.
 */
export async function readPlacementConnections(options:{connection:string;branchId:string},signal:AbortSignal):Promise<TrialConnections>{
 validateReleaseDatabaseTarget(options.connection,options.branchId);signal.throwIfAborted();
 const db=postgres(options.connection,{max:1,prepare:false,fetch_types:false,ssl:'verify-full',connect_timeout:5,onnotice:()=>{}});
 const cancel=()=>{void db.end({timeout:0}).catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{
  const rows=await db.begin('read only',async tx=>{
   await tx`set local statement_timeout='5s'`;await tx`set local transaction_timeout='8s'`;
   return await tx`select app.connection_snapshot() as snapshot`;
  });
  signal.throwIfAborted();return parsePlacementConnections(rows[0]?.snapshot,Date.now());
 }catch(error){
  signal.throwIfAborted();
  if((error as {code?:unknown})?.code==='53300')throw Error('TRIAL_CONNECTION_REFUSED');
  throw Error('TRIAL_CONNECTION_UNAVAILABLE');
 }finally{signal.removeEventListener('abort',cancel);await db.end({timeout:1}).catch(()=>{});}
}
export function parsePlacementConnections(value:any,at:number):TrialConnections{
 if(!value||!Number.isInteger(value.max_connections)||!Number.isInteger(value.reserved_connections)||value.reserved_connections<0||value.max_connections<=value.reserved_connections||!Array.isArray(value.groups)||!value.groups.length)throw Error('TRIAL_CONNECTION_RESPONSE_INVALID');
 let total=0;
 for(const group of value.groups){if(!['auth','social','jobs','other'].includes(group.role)||!Number.isInteger(group.connections)||group.connections<0)throw Error('TRIAL_CONNECTION_RESPONSE_INVALID');total+=group.connections;}
 return{at,total,usable:value.max_connections-value.reserved_connections,refused:false};
}

const count=(value:unknown)=>{if(!['string','number'].includes(typeof value)||value==='')throw Error('TRIAL_METRICS_RESPONSE_INVALID');const n=Number(value);if(!Number.isFinite(n)||n<0)throw Error('TRIAL_METRICS_RESPONSE_INVALID');return n;};
/** Analytics Engine is weighted and may lag. Empty aggregates are missing,
 * never evidence of zero failures. Direct snapshots remain the capacity gate.
 */
export async function readPlacementMetrics(options:{accountId:string;token:string;environment:'staging'|'production';fetch?:typeof fetch},since:number,signal:AbortSignal):Promise<TrialMetrics>{
 if(!/^[a-f0-9]{32}$/.test(options.accountId)||options.token.length<20||!['staging','production'].includes(options.environment)||!Number.isSafeInteger(since))throw Error('TRIAL_METRICS_SCOPE_INVALID');
 const minutes=Math.max(1,Math.ceil((Date.now()-since)/60000));if(minutes>20||since>Date.now())throw Error('TRIAL_METRICS_WINDOW_INVALID');
 const query=async(select:string,where:string)=>{
  const r=await (options.fetch??fetch)(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/analytics_engine/sql`,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),headers:{Authorization:'Bearer '+options.token,'Content-Type':'text/plain'},body:`SELECT ${select} FROM porchday_${options.environment}_operations_v1 WHERE timestamp>NOW()-INTERVAL '${minutes}' MINUTE AND blob1='porchday_metrics_v1' AND ${where} FORMAT JSON`});
  if(!r.ok){await r.body?.cancel();throw Error('TRIAL_METRICS_UNAVAILABLE');}
  const reader=r.body?.getReader();if(!reader)throw Error('TRIAL_METRICS_RESPONSE_INVALID');const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024)throw Error('TRIAL_METRICS_RESPONSE_INVALID');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const value=JSON.parse(Buffer.concat(chunks).toString());if(!Array.isArray(value.data))throw Error('TRIAL_METRICS_RESPONSE_INVALID');return value.data;
 };
 const results=await Promise.allSettled([
  query('sum(_sample_interval) AS requests,sum(if(double1>=500,_sample_interval,0)) AS server_errors',"blob3='request' AND blob4 LIKE '/api/%' AND blob4!='/api/operations/health'"),
  query('blob4 AS route,blob6 AS code,sum(double3*_sample_interval) AS count',"blob3 IN ('db_conn','db_snapshot') GROUP BY route,code"),
 ]);
 for(const result of results)if(result.status==='rejected')throw Error('TRIAL_METRICS_UNAVAILABLE');
 const [aggregate,connections]=results.map(r=>(r as PromiseFulfilledResult<any[]>).value);
 let allErrors:TrialMetrics['allErrors']=null;
 if(aggregate.length===1&&aggregate[0].requests!==null&&aggregate[0].server_errors!==null){const requests=count(aggregate[0].requests),server_errors=count(aggregate[0].server_errors);if(server_errors>requests)throw Error('TRIAL_METRICS_RESPONSE_INVALID');if(requests>0)allErrors={requests,server_errors};}
 const codes=/^(?:(?:auth|social|jobs)_(?:open|close|open_at_response)|refused_(?:53300|53400|hyperdrive)|connect_timeout|snapshot_(?:failed|refused)|(?:auth|social|jobs|other)_(?:active|idle|idle_in_transaction|idle_in_transaction_aborted|fastpath|disabled|unknown)|max_connections|reserved_connections)$/;
 const routes=connections.map(row=>{
  if(typeof row.route!=='string'||!/^(?:none|job:(?:cron|queue)|\/api(?:\/[a-zA-Z0-9_:*-]+)+)$/.test(row.route)||typeof row.code!=='string'||!codes.test(row.code))throw Error('TRIAL_METRICS_DIMENSION_INVALID');
  return{route:row.route,code:row.code,count:count(row.count)};
 });
 return{allErrors,routes,refused:routes.some(row=>row.count>0&&/^(refused_|snapshot_refused)/.test(row.code)),coverage:`Weighted Analytics Engine rolling ${minutes}-minute window; absent groups are not complete zero-count evidence.`};
}
