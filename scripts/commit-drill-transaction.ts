import {z} from 'zod';
import type {Sql} from 'postgres';
import type {AuthPrivacyCommitScope} from '../apps/api/src/privacy-journal';

export const commitDrillFixtureSchema=z.object({runId:z.uuid(),memberId:z.uuid(),sessionId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}).strict();
export type CommitDrillFixture=z.infer<typeof commitDrillFixtureSchema>;
export function commitDrillIdentity(input:CommitDrillFixture){const f=commitDrillFixtureSchema.parse(input);return{email:`${f.runId}.${f.memberId}@example.test`,name:`Synthetic commit recovery drill ${f.runId}`};}

/** Only the exact owned session is deleted. The marker is the final SQL action
 * in the SAME transaction. Caller must already have durable intent/scope proof.
 * A rejection after COMMIT starts is unknown; callers must never replay it. */
export async function commitDrillSession(sql:Sql,input:CommitDrillFixture,scope:AuthPrivacyCommitScope){
 const fixture=commitDrillFixtureSchema.parse(input),identity=commitDrillIdentity(fixture);
 const checked=z.object({operationId:z.uuid(),scopeSha256:z.string().regex(/^[a-f0-9]{64}$/),generation:z.uuid()}).strict().parse(scope);
 return sql.begin(async tx=>{
  await tx`set local statement_timeout='5s'`;await tx`set local lock_timeout='1s'`;await tx`set local transaction_timeout='15s'`;
  await tx`set local role porchday_auth`;
  await tx`select pg_advisory_xact_lock(hashtextextended('porchday-identity:'||${fixture.memberId},0))`;
  const users=await tx`select id from public.auth_user where id=${fixture.memberId} and email=${identity.email} and name=${identity.name} for update`;
  if(users.length!==1)throw Error('DRILL_FIXTURE_OWNER_CHANGED');
  const removed=await tx`delete from public.auth_session where id=${fixture.sessionId} and "userId"=${fixture.memberId} returning id`;
  if(removed.length!==1)throw Error('DRILL_SESSION_CHANGED');
  const rows=await tx`select app.complete_privacy_transaction(${checked.operationId}::uuid,${checked.scopeSha256},${checked.generation}::uuid) as sequence`;
  const sequence=String(rows[0]?.sequence);if(!/^[1-9][0-9]*$/.test(sequence))throw Error('DRILL_MARKER_INVALID');
  return{operationId:checked.operationId,sequence};
 });
}
