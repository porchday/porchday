import {z} from 'zod';
import {controlSchema,journalPointerSchema,journalBatchSchema,privacyIntentSchema,JournalError,sha256,type JournalControl,type JournalStore} from './privacy-journal';

const sequence=z.string().regex(/^(0|[1-9][0-9]*)$/);
/** Opt-in evidence for exactly one transaction, never a generic multi-step route. */
export const privacyCommitScopeSchema=z.object({
 v:z.literal(1),id:z.uuid(),started_at:z.string().datetime(),generation:z.uuid(),
 transaction:z.literal('single-auth-transaction'),intent_sha256:z.string().regex(/^[a-f0-9]{64}$/),
 baseline:z.object({sequence,head:journalPointerSchema.nullable()}).strict(),
}).strict();
export const privacyCommitMarkerSchema=z.object({
 kind:z.literal('privacy_operation_committed'),operation_id:z.uuid(),scope_sha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PrivacyCommitProof={sequence:string;scopeSha256:string};
type Limits={maxReads?:number;maxBatches?:number;signal?:AbortSignal};
const fail=(code:string):never=>{throw new JournalError(code);};
const samePointer=(a:JournalControl['head'],b:JournalControl['head'])=>a===null?b===null:b!==null&&a.key===b.key&&a.hash===b.hash;

/** Read-only proof, not permission to retire an intent or release quarantine.
 * Only a marker in the supplied canonical R2 ancestry after its exact opt-in
 * baseline counts. SQL rows, orphan batches and elapsed time are not evidence.
 * No production caller uses this protocol until its atomic SQL writer and
 * restore handling, crash tests and guarded rollout are implemented.
 */
export async function provePrivacyCommits(
 store:Pick<JournalStore,'get'>,input:JournalControl,
 intents:JournalControl['pending']=input.pending,limits:Limits={},
):Promise<Map<string,PrivacyCommitProof>>{
 const maxReads=limits.maxReads??1024,maxBatches=limits.maxBatches??512;
 if(!Number.isInteger(maxReads)||maxReads<1||maxReads>1024||!Number.isInteger(maxBatches)||maxBatches<1||maxBatches>512)fail('JOURNAL_COMMIT_PROOF_LIMIT');
 let control:JournalControl;
 try{control=controlSchema.parse(input);}catch{return fail('INVALID_JOURNAL_COMMIT_PROOF');}
 if(new Set(control.pending.map(p=>p.id)).size!==control.pending.length||new Set(intents.map(p=>p.id)).size!==intents.length)fail('INVALID_JOURNAL_COMMIT_PROOF');
 let reads=0;
 async function read(key:string,maxBytes:number){
  limits.signal?.throwIfAborted();if(++reads>maxReads)fail('JOURNAL_COMMIT_PROOF_LIMIT');
  let object:Awaited<ReturnType<JournalStore['get']>>,text:string;
  try{object=await store.get(key);}catch{return fail('JOURNAL_STORE_READ_FAILED');}
  limits.signal?.throwIfAborted();if(!object)return null;
  try{text=await object.text();}catch{return fail('JOURNAL_STORE_READ_FAILED');}
  limits.signal?.throwIfAborted();if(new TextEncoder().encode(text).length>maxBytes)fail('JOURNAL_COMMIT_PROOF_LIMIT');
  return text;
 }
 const entries=new Map<string,{scope:z.infer<typeof privacyCommitScopeSchema>;digest:string;baselineReached:boolean;proof?:PrivacyCommitProof}>();
 for(const intent of intents){
  if(!control.pending.some(p=>p.id===intent.id&&p.started_at===intent.started_at))fail('INVALID_JOURNAL_COMMIT_PROOF');
  const raw=await read(`commit-scopes/v1/${intent.id}.json`,16384);if(raw===null)continue;
  let scope:z.infer<typeof privacyCommitScopeSchema>;
  try{scope=privacyCommitScopeSchema.parse(JSON.parse(raw));}catch{return fail('INVALID_JOURNAL_COMMIT_PROOF');}
  if(scope.id!==intent.id||scope.started_at!==intent.started_at||scope.generation!==control.generation||BigInt(scope.baseline.sequence)>BigInt(control.sequence)||(scope.baseline.sequence==='0')!==(scope.baseline.head===null))fail('INVALID_JOURNAL_COMMIT_PROOF');
  const original=await read(`intents/${intent.id}.json`,16384);if(original===null)fail('INVALID_JOURNAL_COMMIT_PROOF');
  let recorded:z.infer<typeof privacyIntentSchema>;
  try{recorded=privacyIntentSchema.parse(JSON.parse(original!));}catch{return fail('INVALID_JOURNAL_COMMIT_PROOF');}
  if(recorded.id!==intent.id||recorded.started_at!==intent.started_at||await sha256(original!)!==scope.intent_sha256)fail('INVALID_JOURNAL_COMMIT_PROOF');
  entries.set(intent.id,{scope,digest:await sha256(raw),baselineReached:false});
 }
 const proven=new Map<string,PrivacyCommitProof>();if(!entries.size)return proven;
 let current=control.head,expected=BigInt(control.sequence),batches=0;
 for(;;){
  limits.signal?.throwIfAborted();
  for(const entry of entries.values())if(!entry.baselineReached){
   const baseline=BigInt(entry.scope.baseline.sequence);
   if(baseline>expected)fail('INVALID_JOURNAL_COMMIT_PROOF');
   if(baseline===expected){
    if(!samePointer(entry.scope.baseline.head,current))fail('INVALID_JOURNAL_COMMIT_PROOF');
    entry.baselineReached=true;
   }
  }
  if([...entries.values()].every(e=>e.baselineReached)){
   for(const [id,entry]of entries)if(entry.proof)proven.set(id,entry.proof);
   return proven;
  }
  if(!current||++batches>maxBatches)fail('JOURNAL_COMMIT_PROOF_LIMIT');
  const raw=await read(current!.key,1024*1024);if(raw===null)fail('JOURNAL_GAP');
  if(await sha256(raw!)!==current!.hash)fail('JOURNAL_HASH_MISMATCH');
  let batch:z.infer<typeof journalBatchSchema>;
  try{batch=journalBatchSchema.parse(JSON.parse(raw!));}catch{return fail('JOURNAL_GAP');}
  if(batch.generation!==control.generation||BigInt(batch.from)<1n||BigInt(batch.to)!==expected||BigInt(batch.from)+BigInt(batch.events.length)-1n!==expected||(batch.from==='1')!==(batch.previous===null)||current!.key!==`batches/${batch.generation}/${batch.from}-${batch.to}-${current!.hash}.json`)fail('JOURNAL_GAP');
  for(let i=0;i<batch.events.length;i++){
   const event=batch.events[i];if(BigInt(event.sequence)!==BigInt(batch.from)+BigInt(i))fail('JOURNAL_GAP');
   if(event.decision.kind!=='privacy_operation_committed')continue;
   let marker:z.infer<typeof privacyCommitMarkerSchema>;
   try{marker=privacyCommitMarkerSchema.parse(event.decision);}catch{return fail('INVALID_JOURNAL_COMMIT_PROOF');}
   const entry=entries.get(marker.operation_id);if(!entry||entry.baselineReached)continue;
   if(entry.proof||marker.scope_sha256!==entry.digest||BigInt(event.sequence)<=BigInt(entry.scope.baseline.sequence))fail('INVALID_JOURNAL_COMMIT_PROOF');
   entry.proof={sequence:event.sequence,scopeSha256:entry.digest};
  }
  expected=BigInt(batch.from)-1n;current=batch.previous;
 }
}
