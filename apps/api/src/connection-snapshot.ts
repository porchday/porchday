import postgres from 'postgres';
import {event,SNAPSHOT_STATES} from './telemetry';
import {trackPostgres} from './connection-metrics';
import type {Env} from './types';

/** Once a minute, record server-wide connection counts by runtime role and
 * state (issue #40). Counts and ages only. A refused snapshot is itself the
 * signal that the server is out of connections. */
type Group={role:string;state:string;connections:number;oldest_transaction_ms:number};
export async function recordConnectionSnapshot(env:Pick<Env,'HYPERDRIVE_JOBS'|'ENVIRONMENT'|'METRICS'>):Promise<void> {
 const sql=trackPostgres(env,'jobs',postgres(env.HYPERDRIVE_JOBS.connectionString,{max:1,prepare:true,fetch_types:false,connect_timeout:5,idle_timeout:1}));
 try{
  const [row]=await sql`select app.connection_snapshot() as value`;
  const value=row.value as {max_connections:number;reserved_connections:number;groups:Group[]};
  event('db_snapshot',{route:'job:cron',code:'max_connections',count:value.max_connections},env);
  event('db_snapshot',{route:'job:cron',code:'reserved_connections',count:value.reserved_connections},env);
  const totals=new Map<string,{count:number;oldest:number}>();
  for(const group of value.groups){
   const state=group.state.replace(/[ ()]+/g,'_').replace(/_+$/,'');
   const code=group.role+'_'+((SNAPSHOT_STATES as readonly string[]).includes(state)?state:'unknown');
   const total=totals.get(code)??{count:0,oldest:0};
   totals.set(code,{count:total.count+group.connections,oldest:Math.max(total.oldest,group.oldest_transaction_ms)});
  }
  // Ages over an hour are reported as one hour, the metric's ceiling.
  for(const [code,total] of totals)event('db_snapshot',{route:'job:cron',code,count:total.count,durationMs:Math.min(total.oldest,3_600_000)},env);
 }catch(error){
  const code=(error as {code?:unknown})?.code;
  event('db_snapshot',{route:'job:cron',code:code==='53300'?'snapshot_refused':'snapshot_failed'},env);
 }finally{await sql.end({timeout:1}).catch(()=>{});}
}
