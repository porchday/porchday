import {z} from 'zod';
import {readJournalControl,privacyIntentSchema,provePrivacyReceipts,sha256,type JournalStore} from '../apps/api/src/privacy-journal';
import {privacyCommitScopeSchema,privacyCommitMarkerSchema,provePrivacyCommits} from '../apps/api/src/privacy-commit-proof';

const sequence=z.string().regex(/^(0|[1-9][0-9]*)$/);
const requestSchema=z.object({memberId:z.uuid(),sessionId:z.uuid(),startedAt:z.number().int().nonnegative(),endedAt:z.number().int().nonnegative(),status:z.literal(200),deniedStatus:z.literal(401)}).strict();
export type AuthCommitRequestWindow=z.infer<typeof requestSchema>;
type ReadDatabase={query:(text:string,values?:unknown[])=>Promise<{rows:unknown[]}>};
type Options={db:ReadDatabase;store:Pick<JournalStore,'get'>;baselineSequence:string;generation:string;requests:AuthCommitRequestWindow[];assertScope:()=>void};
const failure=()=>new Error('AUTH_COHORT_PROOF_UNVERIFIED');

/** Cohort evidence only: anonymous commit scopes do not bind a marker to a
 * member. Window matching must never be presented as per-request identity. */
export async function proveAuthCommitCohort(input:Options,caller:AbortSignal){
 const signal=AbortSignal.any([caller,AbortSignal.timeout(60000)]);
 const check=(value:unknown)=>{signal.throwIfAborted();input.assertScope();if(!value)throw failure();};
 async function bounded<T>(work:()=>Promise<T>):Promise<T>{
  check(true);const readSignal=AbortSignal.any([signal,AbortSignal.timeout(10000)]);let abort:()=>void=()=>{};
  try{return await Promise.race([work(),new Promise<never>((_,reject)=>{abort=()=>reject(failure());readSignal.addEventListener('abort',abort,{once:true});if(readSignal.aborted)abort();})]);}
  finally{readSignal.removeEventListener('abort',abort);}
 }
 try{
  check(true);const requests=z.array(requestSchema).min(2).max(4).parse(input.requests),baseline=sequence.parse(input.baselineSequence),generation=z.uuid().parse(input.generation);
  check(new Set(requests.map(r=>r.memberId)).size===requests.length&&new Set(requests.map(r=>r.sessionId)).size===requests.length);
  const now=Date.now();check(requests.every(r=>r.endedAt>=r.startedAt&&r.endedAt-r.startedAt<=10000&&r.endedAt<=now));
  check(Math.max(...requests.map(r=>r.startedAt))<Math.min(...requests.map(r=>r.endedAt)));
  let reads=0;
  const store:JournalStore={get:async key=>{
   check(++reads<=1024);const object=await bounded(()=>input.store.get(key));check(true);if(!object)return null;
   return{etag:object.etag,text:async()=>{const text=await bounded(()=>object.text());check(Buffer.byteLength(text)<=1024*1024);return text;}};
  },put:async()=>{throw failure();}};
  const result=await bounded(()=>input.db.query('SELECT c.operation_id,c.scope_sha256,c.generation,c.sequence::text,j.decision FROM app.privacy_operation_commits c JOIN app.safety_journal j USING(sequence) WHERE c.sequence>$1::bigint ORDER BY c.sequence LIMIT 5',[baseline]));
  const fenceSchema=z.object({operation_id:z.uuid(),scope_sha256:z.string().regex(/^[a-f0-9]{64}$/),generation:z.uuid(),sequence,decision:privacyCommitMarkerSchema}).strict();
  const fences=z.array(fenceSchema).parse(result.rows);check(fences.length===requests.length);
  check(new Set(fences.map(f=>f.operation_id)).size===fences.length&&new Set(fences.map(f=>f.sequence)).size===fences.length);
  const intents:z.infer<typeof privacyIntentSchema>[]=[];
  async function text(key:string){const object=await store.get(key);check(object);const raw=await object!.text();check(Buffer.byteLength(raw)<=16384);return raw;}
  for(const fence of fences){
   check(fence.generation===generation&&BigInt(fence.sequence)>BigInt(baseline)&&fence.decision.operation_id===fence.operation_id&&fence.decision.scope_sha256===fence.scope_sha256);
   const original=await text(`intents/${fence.operation_id}.json`),intent=privacyIntentSchema.parse(JSON.parse(original));
   const rawScope=await text(`commit-scopes/v1/${fence.operation_id}.json`),scope=privacyCommitScopeSchema.parse(JSON.parse(rawScope));
   check(intent.id===fence.operation_id&&scope.id===intent.id&&scope.started_at===intent.started_at&&scope.generation===generation&&scope.intent_sha256===await sha256(original)&&await sha256(rawScope)===fence.scope_sha256&&BigInt(fence.sequence)>BigInt(scope.baseline.sequence));
   intents.push(intent);
  }
  // A bijection is required, not just membership in the union of windows.
  // Count at most two solutions so ambiguity is explicitly reported.
  let matches=0;const used=new Set<number>();
  function match(index:number){if(matches>=2)return;if(index===intents.length){matches++;return;}const time=Date.parse(intents[index].started_at);
   for(let i=0;i<requests.length;i++){if(used.has(i)||time<requests[i].startedAt||time>requests[i].endedAt)continue;used.add(i);match(index+1);used.delete(i);}}
  match(0);check(matches>0);
  const control=(await readJournalControl(store)).value;check(control.mode==='active'&&control.generation===generation&&control.pending.length===0);
  // This local proof input names original retired intents; it never writes control.
  const proofControl={...control,pending:intents.map(({id,started_at})=>({id,started_at}))};
  const commits=await provePrivacyCommits(store,proofControl,undefined,{signal}),receipts=await provePrivacyReceipts(store,proofControl);
  for(const fence of fences){const proof=commits.get(fence.operation_id);check(proof?.sequence===fence.sequence&&proof.scopeSha256===fence.scope_sha256&&receipts.has(fence.operation_id));}
  const state=await bounded(()=>input.db.query('SELECT app.safety_status() AS status,(SELECT count(*)::text FROM public.auth_session WHERE id=ANY($1::text[])) AS sessions,(SELECT count(*)::text FROM public.auth_user WHERE id=ANY($2::text[])) AS users',[requests.map(r=>r.sessionId),requests.map(r=>r.memberId)]));
  const row=z.object({status:z.object({generation:z.uuid(),sequence,quarantined:z.boolean()}).passthrough(),sessions:sequence,users:sequence}).strict().parse(state.rows.length===1?state.rows[0]:null);
  check(row.sessions==='0'&&row.users===String(requests.length)&&!row.status.quarantined&&row.status.generation===generation&&BigInt(row.status.sequence)>=BigInt(control.sequence));
  const finalControl=(await readJournalControl(store)).value;check(JSON.stringify(finalControl)===JSON.stringify(control));
  return{at:new Date().toISOString(),passed:true as const,count:requests.length,generation,baselineSequence:baseline,canonicalSequence:control.sequence,commits:fences.map(f=>({operationId:f.operation_id,sequence:f.sequence})),windowMatching:matches===1?'unique-by-time' as const:'ambiguous-by-time' as const,perRequestIdentityProved:false as const,overlappingClientWindows:true as const,ownedSessionsAbsent:true as const,ownedAccountsPresent:true as const,canonicalMarkersAndReceipts:true as const,retired:true as const,reads,providerWrites:0,databaseWrites:0};
 }catch{throw failure();}
}
