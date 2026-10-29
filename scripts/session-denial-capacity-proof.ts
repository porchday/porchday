import {parseDenialProgress,denialProgressHealth,type DenialProgress} from '../apps/api/src/session-denial-progress';

type Pass=NonNullable<DenialProgress['lastPass']>;
export type ExactCandidateProgress=Pick<DenialProgress,'pageCompletedAt'|'passStartedAt'|'passSeen'|'passInvalid'|'lastPass'>;
/** Parse the real v3 object but never return its cursor/session identifier. */
export function exactCandidateProgress(text:string):ExactCandidateProgress{
 if(text.length>16384)throw Error('CAPACITY_PROGRESS_INVALID');
 const raw=JSON.parse(text);
 if(raw?.v!==3||raw.strategy!=='sql-session-keyset')throw Error('CAPACITY_PROGRESS_INVALID');
 const {strategy:_,...fields}=raw;
 const value=parseDenialProgress(JSON.stringify({...fields,v:2}));
 return {pageCompletedAt:value.pageCompletedAt,passStartedAt:value.passStartedAt,passSeen:value.passSeen,passInvalid:value.passInvalid,lastPass:value.lastPass};
}

/** Additional acceptance evidence, not a substitute for preserved fixtures,
 * healthy user journeys, provider reconciliation or cleanup. Seed time must be
 * the confirmed fixture commit time, never the beginning of the seeding request.
 * Persist every sanitized observation before passing it here. Missing evidence
 * fails conservatively; no interpolation of ages or fabricated progress. */
export class CandidateCapacityProof{
 private previous:ExactCandidateProgress;
 private observedAt:number;
 private failed=false;
 private passes:Pass[]=[];
 private gaps:number[]=[];
 constructor(private readonly seededAt:number,private readonly minimumCandidates:number,baseline:ExactCandidateProgress,baselineObservedAt:number){
  if(!Number.isSafeInteger(seededAt)||seededAt<0||!Number.isSafeInteger(minimumCandidates)||minimumCandidates<1||minimumCandidates>1_000_000||baselineObservedAt>seededAt)throw Error('CAPACITY_PROOF_SCOPE');
  this.previous=structuredClone(baseline);this.observedAt=baselineObservedAt;
  this.checkHealth(baseline,baselineObservedAt);
 }
 private checkHealth(progress:ExactCandidateProgress,observedAt:number):void{
  if(!Number.isSafeInteger(observedAt)||observedAt<0||!progress.lastPass)throw Error('CAPACITY_PROGRESS_UNKNOWN');
  // Validate sanitized caller data too, not only objects produced by our parser.
  const parsed=parseDenialProgress(JSON.stringify({v:2,cursor:progress.passStartedAt===null?null:'capacity-proof',...progress}));
  if(denialProgressHealth(parsed,observedAt).issues.length)throw Error('CAPACITY_PROGRESS_UNHEALTHY');
 }
 observe(progress:ExactCandidateProgress,observedAt:number):void{
  if(this.failed)throw Error('CAPACITY_PROOF_FAILED');
  try{
   this.checkHealth(progress,observedAt);
   const prior=this.previous,last=progress.lastPass!,old=prior.lastPass!;
   if(observedAt<this.observedAt||progress.pageCompletedAt<prior.pageCompletedAt||last.completedAt<old.completedAt)throw Error('CAPACITY_PROGRESS_REGRESSED');
   if(last.completedAt===old.completedAt){
    if(last.durationMs!==old.durationMs||last.seen!==old.seen||last.invalid!==old.invalid)throw Error('CAPACITY_PASS_CHANGED');
   }else{
    // A fresh current age can conceal a stale interval since the preceding pass.
    // Comparing persisted timestamps also cancels a constant operator clock offset.
    const gap=last.completedAt-old.completedAt;
    if(gap>300000)throw Error('CAPACITY_FULL_PASS_INTERVAL_EXCEEDED');
    if(last.completedAt-last.durationMs<old.completedAt)throw Error('CAPACITY_PASS_OVERLAP');
    if(this.gaps.length>=512)throw Error('CAPACITY_EVIDENCE_LIMIT');
    this.gaps.push(gap);
    if(last.completedAt-last.durationMs>=this.seededAt&&last.seen>=this.minimumCandidates)this.passes.push(structuredClone(last));
   }
   this.previous=structuredClone(progress);this.observedAt=observedAt;
  }catch(error){this.failed=true;throw error;}
 }
 get completedPassCount():number{
  if(this.failed)throw Error('CAPACITY_PROOF_FAILED');
  return this.passes.length;
 }
 finish(){
  if(this.failed)throw Error('CAPACITY_PROOF_FAILED');
  if(this.passes.length<2)throw Error('CAPACITY_TWO_FULL_PASSES_REQUIRED');
  return {completedPasses:structuredClone(this.passes),fullPassIntervalsMs:[...this.gaps],maxFullPassIntervalMs:Math.max(...this.gaps),
   limitations:['Exact observed full-pass intervals only; no claim of continuous page freshness or complete user-journey coverage.','A missed intermediate pass can cause conservative rejection; never infer a missing completion.']};
 }
}
