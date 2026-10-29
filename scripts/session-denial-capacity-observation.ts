const stages=['probe','health','fixture_count','exact_progress'] as const;
export type CapacityObservationStage=typeof stages[number];
type ErrorKind='AbortError'|'TimeoutError'|'SyntaxError'|'TypeError'|'Error'|'OtherError';
export type CapacityObservationEvent={
 v:1;sample:number;stage:CapacityObservationStage;
 state:'started'|'retained'|'failed';
 failureAt?:'operation'|'retention';errorKind?:ErrorKind;
};
function kind(error:unknown):ErrorKind{
 // Do not serialize messages, causes, stacks, driver fields or arbitrary names.
 try{const name=(error as {name?:unknown})?.name;
  if(name==='AbortError'||name==='TimeoutError'||name==='SyntaxError'||name==='TypeError'||name==='Error')return name;
 }catch{/* A thrown object may have a hostile getter. */}
 return 'OtherError';
}
export class CapacityObservationError extends Error{
 constructor(readonly stage:CapacityObservationStage,readonly failureAt:'start_record'|'operation'|'retention',readonly errorKind:ErrorKind,readonly failureRecordWritten:boolean){
  super('CAPACITY_OBSERVATION_FAILED');this.name='CapacityObservationError';
 }
}

/** The caller supplies a durable append-only event sink and a separate private
 * result sink. Confirm the start record before I/O and retain each result before
 * returning it. This helper never retries work, infers missing results or logs
 * result values. A failed/uncertain call must invalidate the trial; cleanup and
 * read-only reconciliation belong to its existing one-shot harness. */
export async function observeCapacityStage<T>(
 context:{sample:number;stage:CapacityObservationStage;record:(event:CapacityObservationEvent)=>void|Promise<void>},
 work:()=>Promise<T>,retain:(value:T)=>void|Promise<void>,
):Promise<T>{
 const {sample,stage,record}=context;
 if(!Number.isSafeInteger(sample)||sample<0||sample>10000||!stages.includes(stage))throw Error('CAPACITY_OBSERVATION_SCOPE');
 const base={v:1 as const,sample,stage};
 try{await record({...base,state:'started'});}
 catch(error){throw new CapacityObservationError(stage,'start_record',kind(error),false);}
 let failureAt:'operation'|'retention'='operation';
 try{
  const value=await work();failureAt='retention';
  await retain(value);await record({...base,state:'retained'});return value;
 }catch(error){
  const errorKind=kind(error);let written=false;
  try{await record({...base,state:'failed',failureAt,errorKind});written=true;}catch{/* No retry of the sink or operation. */}
  throw new CapacityObservationError(stage,failureAt,errorKind,written);
 }
}
