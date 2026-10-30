import type {Pool} from 'pg';
import type {JournalStore} from './privacy-journal';
import {candidatePageSize,candidateProgressKey,parseCandidateProgress,candidateProgressHealth,type SessionCandidatePage} from './session-denial-candidates';
import {DenialCleanupError} from './session-denial-cleanup';

// Versioned fixed ranges cover the entire SQL text ordering, including invalid
// non-UUID candidates. Comparisons and cursor validation use the same database
// collation as the primary-key index. No JavaScript string ordering is assumed.
export const denialPartitions=[0,1,2] as const;
export type DenialPartition=typeof denialPartitions[number];
const ranges=[[null,'5'],['5','a'],['a',null]] as const;
function bounds(partition:DenialPartition){
 if(!denialPartitions.includes(partition))throw new DenialCleanupError();
 return ranges[partition];
}
export function partitionProgressKey(partition:DenialPartition){bounds(partition);return `session-denial-maintenance/v4/range-${partition}.json`;}
type CandidateProgress=ReturnType<typeof parseCandidateProgress>;
export type PartitionProgress=Omit<CandidateProgress,'v'|'strategy'>&{v:4;strategy:'sql-session-ranges';partition:DenialPartition};
export function parsePartitionProgress(text:string,expected:DenialPartition):PartitionProgress{
 bounds(expected);if(text.length>16384)throw new DenialCleanupError();
 const {v,strategy,partition,...fields}=JSON.parse(text);
 if(v!==4||strategy!=='sql-session-ranges'||partition!==expected)throw new DenialCleanupError();
 const {v:_,strategy:__,...checked}=parseCandidateProgress(JSON.stringify({...fields,v:3,strategy:'sql-session-keyset'}));
 return {...checked,v:4,strategy:'sql-session-ranges',partition:expected};
}
/** Reuse the tested prefix/CAS engine while isolating every shard's persisted
 * evidence. v3 is only an in-memory engine representation; never read or update
 * the real v3 checkpoint. Unknown replies retain the engine's existing rules. */
export function partitionStore(store:JournalStore,partition:DenialPartition):JournalStore{
 const key=partitionProgressKey(partition);
 return {
  async get(requested){
   if(requested!==candidateProgressKey){
    if(!/^session-denials\/v1\/[a-f0-9]{64}\.json$/.test(requested))throw new DenialCleanupError();
    return store.get(requested);
   }
   const object=await store.get(key);if(!object)return null;
   const {partition:_,v:__,strategy:___,...value}=parsePartitionProgress(await object.text(),partition);
   return {etag:object.etag,text:async()=>JSON.stringify({...value,v:3,strategy:'sql-session-keyset'})};
  },
  async put(requested,text,options){
   if(requested!==candidateProgressKey)throw new DenialCleanupError();
   const {v:_,strategy:__,...value}=parseCandidateProgress(text);
   return store.put(key,JSON.stringify({...value,v:4,strategy:'sql-session-ranges',partition}),options);
  },
 };
}
/** Read-only keyset discovery. A foreign-range cursor is an error, never an
 * empty successful pass. Range predicates remain indexable and all comparisons
 * use PostgreSQL's ordering. No connection is held during authority reads. */
export async function listPartitionCandidates(pool:Pool,partition:DenialPartition,after:string|null):Promise<SessionCandidatePage>{
 const [lower,upper]=bounds(partition);
 if(after!==null&&(typeof after!=='string'||!after||after.length>8192))throw new DenialCleanupError();
 const client=await pool.connect();let failed=false;
 const query=(text:string,values?:unknown[])=>{const config={text,values,query_timeout:6000};return client.query(config);};
 try{
  await query("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'");
  if(after!==null){
   const validity=await query('SELECT ($2::text IS NULL OR $1::text >= $2) AND ($3::text IS NULL OR $1::text < $3) AS valid',[after,lower,upper]);
   if(validity.rows.length!==1||validity.rows[0].valid!==true)throw new DenialCleanupError();
  }
  // Choose bounded static predicates instead of nullable OR clauses, so the
  // keyset/range constraints can directly use the existing primary-key index.
  const values:unknown[]=[candidatePageSize+1],where:string[]=[];
  if(lower!==null){values.push(lower);where.push('id >= $'+values.length);}
  if(upper!==null){values.push(upper);where.push('id < $'+values.length);}
  if(after!==null){values.push(after);where.push('id > $'+values.length);}
  const result=await query('SELECT id FROM public.auth_session WHERE '+where.join(' AND ')+' ORDER BY id LIMIT $1',values);
  await query('COMMIT');return {ids:result.rows.slice(0,candidatePageSize).map(row=>row.id),more:result.rows.length>candidatePageSize};
 }catch{failed=true;await query('ROLLBACK').catch(()=>{});throw new DenialCleanupError();}
 finally{client.release(failed);}
}
/** Every range must independently meet the existing page/pass limits. The
 * oldest range controls freshness; no busy shard can hide a stalled one. Counts
 * summarize separate range passes, not one shared transactional SQL snapshot. */
export function partitionCleanupHealth(progress:readonly (PartitionProgress|null)[],now=Date.now()){
 if(progress.length!==denialPartitions.length)throw new DenialCleanupError();
 if(progress.some(value=>value===null))return {issues:['session_denial_cleanup_missing'],snapshot:null};
 const health=progress.map((value,index)=>{
  const {partition:_,v:__,strategy:___,...checked}=parsePartitionProgress(JSON.stringify(value),denialPartitions[index]);
  return candidateProgressHealth({...checked,v:3,strategy:'sql-session-keyset'},now);
 });
 const sum=(values:number[])=>{const value=values.reduce((a,b)=>a+b,0);if(!Number.isSafeInteger(value))throw new DenialCleanupError();return value;};
 const snapshots=health.map(value=>value.snapshot),complete=snapshots.every(value=>value.pass_age_seconds!==null);
 return {issues:[...new Set(health.flatMap(value=>value.issues))],snapshot:{
  page_age_seconds:Math.max(...snapshots.map(value=>value.page_age_seconds)),
  pass_age_seconds:complete?Math.max(...snapshots.map(value=>value.pass_age_seconds!)):null,
  last_pass_duration_seconds:complete?Math.max(...snapshots.map(value=>value.last_pass_duration_seconds!)):null,
  last_pass_seen:complete?sum(snapshots.map(value=>value.last_pass_seen!)):null,
  current_pass_seen:sum(snapshots.map(value=>value.current_pass_seen)),
  invalid_records:sum(snapshots.map(value=>value.invalid_records)),
 }};
}
