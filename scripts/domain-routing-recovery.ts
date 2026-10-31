/** Domain transitions are separate from Worker activation. No I/O on import.
 * The adapter must hold the deployment lease and durably compare-and-set the
 * journal. An uncertain provider write is observed, never replayed.
 */
import {createHash} from 'node:crypto';

export type DomainTarget = Readonly<{hostname:string;service:string;environment:string;zoneId:string}>;
export type DomainMove = Readonly<{before:DomainTarget;after:DomainTarget}>;
export type RoutingPlan = Readonly<{operationId:string;moves:readonly DomainMove[]}>;
export type RoutingState = Readonly<{planHash:string;revision:number;direction:'forward'|'rollback';completed:number;intent:boolean;terminal:boolean}>;
export interface RoutingPorts {
 read():Promise<RoutingState|null>;
 write(previous:RoutingState|null,next:RoutingState):Promise<void>;
 /** Lease, canonical release, active versions and unchanged collateral state. */
 authorize(plan:RoutingPlan):Promise<void>;
 observe(hostname:string):Promise<DomainTarget>;
 /** Single bounded provider call. No retry even on a lost reply. */
 assign(target:DomainTarget):Promise<void>;
}
const equal=(a:DomainTarget,b:DomainTarget)=>a.hostname===b.hostname&&a.service===b.service&&a.environment===b.environment&&a.zoneId===b.zoneId;
export function routingPlanHash(plan:RoutingPlan):string {
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(plan.operationId)||!plan.moves.length)throw Error('ROUTING_PLAN_INVALID');
 const names=new Set<string>();
 for(const {before,after} of plan.moves){
  for(const t of [before,after])if(!/^[a-z0-9.-]+$/.test(t.hostname)||!/^porchday-(production|staging)(-edge)?$/.test(t.service)||t.environment!=='production'||! /^[a-f0-9]{32}$/.test(t.zoneId))throw Error('ROUTING_TARGET_INVALID');
  if(names.has(before.hostname)||before.hostname!==after.hostname||before.zoneId!==after.zoneId||equal(before,after))throw Error('ROUTING_MOVE_INVALID');
  const environment=before.service.replace(/^porchday-/, '').replace(/-edge$/, '');
  const allowed=environment==='production'?['porchday.org','www.porchday.org','porchday.com','www.porchday.com']:['staging.porchday.com','staging.porchday.org'];
  if(!allowed.includes(before.hostname)||![`porchday-${environment}`,`porchday-${environment}-edge`].includes(after.service))throw Error('ROUTING_SCOPE_INVALID');
  names.add(before.hostname);
 }
 return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export function validateRoutingState(plan:RoutingPlan,state:RoutingState):void {
 if(!state||Object.keys(state).sort().join(',')!=='completed,direction,intent,planHash,revision,terminal'||state.planHash!==routingPlanHash(plan)||!Number.isSafeInteger(state.revision)||state.revision<1||!Number.isSafeInteger(state.completed)||state.completed<0||state.completed>plan.moves.length||!['forward','rollback'].includes(state.direction)||typeof state.intent!=='boolean'||typeof state.terminal!=='boolean')throw Error('ROUTING_JOURNAL_INVALID');
 const endpoint=state.direction==='forward'?plan.moves.length:0;
 if(state.terminal&&(state.intent||state.completed!==endpoint)||state.intent&&state.completed===endpoint)throw Error('ROUTING_JOURNAL_INVALID');
}
export function validateRoutingTransition(plan:RoutingPlan,previous:RoutingState|null,next:RoutingState):void {
 validateRoutingState(plan,next);
 if(previous)validateRoutingState(plan,previous);
 if(next.revision!==(previous?.revision??0)+1)throw Error('ROUTING_JOURNAL_TRANSITION');
 if(!previous){if(next.direction!=='forward'||next.completed!==0||next.intent||next.terminal)throw Error('ROUTING_JOURNAL_TRANSITION');return;}
 const p=previous,n=next;
 const rollback=p.direction==='forward'&&n.direction==='rollback'&&!p.intent&&!n.intent&&!n.terminal&&n.completed===p.completed;
 const sameDirection=p.direction===n.direction&&!p.terminal;
 const intent=sameDirection&&!p.intent&&n.intent&&!n.terminal&&n.completed===p.completed;
 const observed=sameDirection&&p.intent&&!n.intent&&!n.terminal&&n.completed===p.completed+(p.direction==='forward'?1:-1);
 const finish=sameDirection&&!p.intent&&!n.intent&&n.terminal&&n.completed===p.completed;
 if(!rollback&&!intent&&!observed&&!finish)throw Error('ROUTING_JOURNAL_TRANSITION');
}

/** Run or reconcile one direction. Rollback reverses only confirmed moves.
 * An outstanding forward intent must first reconcile before rollback can start.
 * Unknown ownership fails closed, including ownership changed by another actor.
 */
export async function recoverRouting(plan:RoutingPlan,ports:RoutingPorts,rollback=false):Promise<'complete'|'rolled-back'|'write-unconfirmed'> {
 plan=Object.freeze({...plan,moves:Object.freeze(plan.moves.map(m=>Object.freeze({before:Object.freeze({...m.before}),after:Object.freeze({...m.after})})))});
 const hash=routingPlanHash(plan);
 let state=await ports.read();
 if(state)validateRoutingState(plan,state);
 const advance=async(fields:Partial<RoutingState>)=>{
  const next:RoutingState={planHash:hash,revision:(state?.revision??0)+1,direction:'forward',completed:0,intent:false,terminal:false,...state,...fields};
  // Revision always advances, including when fields come from the old state.
  const durable={...next,revision:(state?.revision??0)+1};
  validateRoutingTransition(plan,state,durable);
  await ports.write(state,durable);state=durable;
 };
 await ports.authorize(plan);
 if(!state)await advance({});
 // Reconcile a previously dispatched write before making any new decision.
 if(state!.intent){
  const index=state!.direction==='forward'?state!.completed:state!.completed-1;
  const move=plan.moves[index];if(!move)throw Error('ROUTING_JOURNAL_INVALID');
  const desired=state!.direction==='forward'?move.after:move.before;
  const old=state!.direction==='forward'?move.before:move.after;
  const observed=await ports.observe(desired.hostname);
  if(equal(observed,old))return 'write-unconfirmed';
  if(!equal(observed,desired))throw Error('ROUTING_CONCURRENT_CHANGE');
  await advance({intent:false,completed:state!.completed+(state!.direction==='forward'?1:-1)});
 }
 if(rollback&&state!.direction==='forward')await advance({direction:'rollback',terminal:false});
 for(;;){
  await ports.authorize(plan);
  // Check the entire expected routing state before each individual write.
  for(let i=0;i<plan.moves.length;i++){
   const expected=i<state!.completed?plan.moves[i].after:plan.moves[i].before;
   if(!equal(await ports.observe(expected.hostname),expected))throw Error('ROUTING_CONCURRENT_CHANGE');
  }
  const forward=state!.direction==='forward';
  if(forward?state!.completed===plan.moves.length:state!.completed===0){
   if(!state!.terminal)await advance({terminal:true});
   return forward?'complete':'rolled-back';
  }
  if(state!.terminal)throw Error('ROUTING_JOURNAL_INVALID');
  const move=plan.moves[forward?state!.completed:state!.completed-1],desired=forward?move.after:move.before;
  await advance({intent:true});
  await ports.authorize(plan);
  try{await ports.assign(desired);}catch{/* Outcome unknown; only GET can reconcile. */}
  const observed=await ports.observe(desired.hostname);
  if(equal(observed,forward?move.before:move.after))return 'write-unconfirmed';
  if(!equal(observed,desired))throw Error('ROUTING_CONCURRENT_CHANGE');
  await advance({intent:false,completed:state!.completed+(forward?1:-1)});
 }
}
