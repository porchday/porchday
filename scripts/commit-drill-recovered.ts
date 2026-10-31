import type {Sql} from 'postgres';
import {z} from 'zod';
import {privacyIntentSchema,readJournalControl,provePrivacyReceipts,journalPointerSchema,type JournalStore,type JournalControl} from '../apps/api/src/privacy-journal';
import {provePrivacyCommits} from '../apps/api/src/privacy-commit-proof';
import {observeCommittedDrill} from './commit-drill-observe';
import type {CommitDrillFixture} from './commit-drill-transaction';
import type {CommitDrillExpected} from './commit-drill-supervisor';

const receiptSchema=z.object({v:z.literal(1),id:z.uuid(),generation:z.uuid(),sequence:z.string().regex(/^(0|[1-9][0-9]*)$/),head:journalPointerSchema.nullable()}).strict();

/** Read-only post-recovery acceptance. Never invokes recovery, advances a clock,
 * retires pending work or writes a receipt. Caller separately proves hosted
 * requests/cron were the recovery path and retains continuity observations. */
export async function observeRecoveredDrill(input:{
 sql:Sql;store:JournalStore;fixture:CommitDrillFixture;expected:CommitDrillExpected;
 publicationSha256:string;reportedSequence:string;pendingAtKill:JournalControl['pending'];
},signal:AbortSignal){
 const options={...input,fixture:structuredClone(input.fixture),expected:structuredClone(input.expected),pendingAtKill:structuredClone(input.pendingAtKill)};
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
 const need=(value:unknown)=>{deadline.throwIfAborted();if(!value)throw Error('DRILL_RECOVERY_UNVERIFIED');};
 const store:JournalStore={async get(key){deadline.throwIfAborted();const object=await input.store.get(key);deadline.throwIfAborted();return object;},async put(){throw Error('DRILL_RECOVERY_READ_ONLY');}};
 let stop!:()=>void;
 const expired=new Promise<never>((_,reject)=>{stop=()=>reject(Error('DRILL_RECOVERY_DEADLINE'));deadline.addEventListener('abort',stop,{once:true});});
 async function verify(){
  deadline.throwIfAborted();
  const expected=options.expected,object=await store.get(`intents/${expected.operationId}.json`);need(object);
  const text=await object!.text();need(Buffer.byteLength(text)<=16384);
  const intent=privacyIntentSchema.parse(JSON.parse(text));
  need(intent.id===expected.operationId&&Date.now()-Date.parse(intent.started_at)>=120000);
  need(options.pendingAtKill.filter(p=>p.id===intent.id).length===1&&options.pendingAtKill.some(p=>p.id===intent.id&&p.started_at===intent.started_at));
  const before=await readJournalControl(store);
  need(before.value.mode==='active'&&before.value.generation===expected.generation&&!before.value.pending.some(p=>p.id===intent.id));
  // Feed the retained original intent to the existing ancestry provers in a
  // local copy only. The authoritative control stays retired and is never put.
  const proofControl={...before.value,pending:[...before.value.pending,{id:intent.id,started_at:intent.started_at}]};
  const proof=(await provePrivacyCommits(store,proofControl,[intent],{signal:deadline})).get(intent.id);
  need(proof?.sequence===options.reportedSequence&&proof.scopeSha256===options.publicationSha256);
  const receiptObject=await store.get(`receipts/${intent.id}.json`);need(receiptObject);
  const receiptText=await receiptObject!.text();need(Buffer.byteLength(receiptText)<=16384);
  const receipt=receiptSchema.parse(JSON.parse(receiptText));
  need(receipt.id===intent.id&&receipt.generation===expected.generation&&BigInt(receipt.sequence)>=BigInt(options.reportedSequence));
  need((await provePrivacyReceipts(store,proofControl,[intent])).has(intent.id));
  const observed=await observeCommittedDrill({...options,store},deadline);
  need(observed.sequence===options.reportedSequence&&observed.fenceSequence===options.reportedSequence&&observed.ownedAccountVerified&&observed.sessionAbsent&&!observed.pendingExact&&!observed.receiptAbsent&&observed.generationUnchanged&&!observed.quarantined&&observed.childReportedCommit);
  const after=await readJournalControl(store);
  need(after.value.mode==='active'&&after.value.generation===expected.generation&&!after.value.pending.some(p=>p.id===intent.id)&&BigInt(after.value.sequence)>=BigInt(before.value.sequence));
  // Conservative admission: do not silently credit removal of unrelated work.
  for(const pending of options.pendingAtKill.filter(p=>p.id!==intent.id))need(before.value.pending.some(p=>p.id===pending.id&&p.started_at===pending.started_at)&&after.value.pending.some(p=>p.id===pending.id&&p.started_at===pending.started_at));
  // Ensure the proved checkpoint is still canonical, even if a concurrent
  // checkpoint advanced the head while SQL was being inspected.
  const finalProof={...after.value,pending:[...after.value.pending,{id:intent.id,started_at:intent.started_at}]};
  need((await provePrivacyReceipts(store,finalProof,[intent])).has(intent.id));
  const finalMarker=(await provePrivacyCommits(store,finalProof,[intent],{signal:deadline})).get(intent.id);
  need(finalMarker?.sequence===proof?.sequence&&finalMarker?.scopeSha256===proof?.scopeSha256);
  return{operationId:intent.id,generation:expected.generation,sequence:options.reportedSequence,receiptSequence:receipt.sequence,canonicalSequence:after.value.sequence,intentAgeMs:Date.now()-Date.parse(intent.started_at),recoveryStateVerified:true as const,hostedRecoveryPathVerified:false as const};
 }
 try{return await Promise.race([verify(),expired]);}finally{deadline.removeEventListener('abort',stop);}
}
