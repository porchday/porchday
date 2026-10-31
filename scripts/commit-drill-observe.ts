import type {Sql} from 'postgres';
import {z} from 'zod';
import {privacyIntentSchema,readJournalControl,sha256,type JournalStore} from '../apps/api/src/privacy-journal';
import {privacyCommitScopeSchema,privacyCommitMarkerSchema} from '../apps/api/src/privacy-commit-proof';
import {commitDrillIdentity,type CommitDrillFixture} from './commit-drill-transaction';
import type {CommitDrillExpected,CommitDrillObservation} from './commit-drill-supervisor';

/** Independent parent reads. The publication digest must come from the durable
 * parent write-intent record, never just the child's phase message. No mutations. */
export async function observeCommittedDrill(options:{sql:Sql;store:JournalStore;fixture:CommitDrillFixture;expected:CommitDrillExpected;publicationSha256:string;reportedSequence:string},signal:AbortSignal):Promise<CommitDrillObservation>{
 const expected=structuredClone(options.expected),fixture=structuredClone(options.fixture),identity=commitDrillIdentity(fixture);
 const need=(v:unknown)=>{signal.throwIfAborted();if(!v)throw Error('DRILL_INDEPENDENT_PROOF_INVALID');};
 need(expected.memberId===fixture.memberId&&expected.sessionId===fixture.sessionId&&options.publicationSha256===expected.scopeSha256);
 async function text(key:string){signal.throwIfAborted();const object=await options.store.get(key);need(object);const value=await object!.text();need(Buffer.byteLength(value)<=16384);return value;}
 const intentText=await text(`intents/${expected.operationId}.json`),intent=privacyIntentSchema.parse(JSON.parse(intentText));
 const scopeText=await text(`commit-scopes/v1/${expected.operationId}.json`),scope=privacyCommitScopeSchema.parse(JSON.parse(scopeText));
 need(intent.id===expected.operationId&&scope.id===intent.id&&scope.started_at===intent.started_at&&scope.generation===expected.generation&&scope.intent_sha256===await sha256(intentText)&&await sha256(scopeText)===options.publicationSha256);
 const before=await readJournalControl(options.store);signal.throwIfAborted();
 const sqlProof=await options.sql.begin('read only',async tx=>{
  await tx`set local statement_timeout='5s'`;await tx`set local lock_timeout='1s'`;await tx`set local transaction_timeout='15s'`;
  const rows=await tx`select c.scope_sha256,c.generation,c.sequence::text as fence_sequence,j.sequence::text as marker_sequence,j.decision from app.privacy_operation_commits c join app.safety_journal j on j.sequence=c.sequence where c.operation_id=${expected.operationId}`;
  need(rows.length===1);const row=rows[0],marker=privacyCommitMarkerSchema.parse(row.decision);
  need(marker.operation_id===expected.operationId&&marker.scope_sha256===expected.scopeSha256&&row.scope_sha256===expected.scopeSha256&&row.generation===expected.generation&&BigInt(row.marker_sequence)>BigInt(scope.baseline.sequence));
  const users=await tx`select id from public.auth_user where id=${fixture.memberId} and name=${identity.name} and email=${identity.email}`;
  const sessions=await tx`select id from public.auth_session where id=${fixture.sessionId}`;
  const [status]=await tx`select app.safety_status() as value`;
  return{row,owned:users.length===1,absent:sessions.length===0,status:z.object({generation:z.uuid(),sequence:z.string().regex(/^(0|[1-9][0-9]*)$/),quarantined:z.boolean()}).strict().parse(status.value)};
 });signal.throwIfAborted();
 const receipt=await options.store.get(`receipts/${expected.operationId}.json`),after=await readJournalControl(options.store);signal.throwIfAborted();
 need(BigInt(sqlProof.status.sequence)>=BigInt(sqlProof.row.marker_sequence)&&BigInt(sqlProof.status.sequence)>=BigInt(before.value.sequence)&&BigInt(sqlProof.status.sequence)>=BigInt(after.value.sequence));
 const pending=(control:typeof before.value)=>control.pending.filter(p=>p.id===intent.id).length===1&&control.pending.some(p=>p.id===intent.id&&p.started_at===intent.started_at);
 return{...expected,sequence:sqlProof.row.marker_sequence,fenceSequence:sqlProof.row.fence_sequence,sessionAbsent:sqlProof.absent,ownedAccountVerified:sqlProof.owned,pendingExact:pending(before.value)&&pending(after.value),receiptAbsent:receipt===null,generationUnchanged:before.value.generation===expected.generation&&after.value.generation===expected.generation&&sqlProof.status.generation===expected.generation,quarantined:before.value.mode!=='active'||after.value.mode!=='active'||sqlProof.status.quarantined,childReportedCommit:options.reportedSequence===sqlProof.row.marker_sequence};
}
