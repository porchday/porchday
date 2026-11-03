import {randomUUID} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {atomicJson,privateDirectory,privateFile} from './external-monitor-store.ts';
import {checkNames} from './external-monitor-alerts.ts';
import type {Observation} from './external-monitor-probe.ts';
import {IncidentCodex} from './incident-codex.ts';

export type DispatchConfig={cwd:string;codexPath:string};
export type Incident={v:1;id:string;at:string;lastAt:string;failures:number;failedChecks:string[];healthySince?:string;closedAt?:string;
 phase:'watching'|'creating'|'ready'|'sending'|'accepted'|'uncertain';threadId?:string;turnId?:string;previousThreadId?:string;lastAttempt?:string;lastEscalation?:string;error?:string};
type Rpc={call(method:string,params:any):Promise<any>;close():void};
type Dependencies={connect:()=>Promise<Rpc>;save:(incident:Incident)=>void;notify:(event:string,id:string)=>void;uuid:()=>string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const RECOVERY_STABILITY_MS=140000;
export function validateDispatchConfig(value:DispatchConfig){
 if(!value||!isAbsolute(value.cwd)||!isAbsolute(value.codexPath))throw Error('INCIDENT_DISPATCH_CONFIGURATION');
}
export function incidentPrompt(incident:Incident,cwd:string,drill=false){
 return `${drill?'Notification drill: perform read-only checks only. Do not change production, create incidents, or send messages.':'The owner has authorized this automatically dispatched Porchday incident task to investigate and restore service without waiting for a chat message.'}
Incident ID: ${incident.id}. First observed: ${incident.at}. Failed checks: ${incident.failedChecks.join(', ')}.
Work from ${cwd}. Begin with fresh public session checks, protected readiness and the independent monitor evidence. Treat this alert as a trigger, not proof that service is still down. If healthy, verify stability beyond the 120-second privacy-intent grace period and report; do not change production unnecessarily.
Read docs/incident-response.md, docs/restore-safety.md, docs/deployment-recovery.md, and docs/incident-dispatch.md. Discover the current canonical deployment and active operation under /Users/bobby/Development/inner-circle/artifacts/private. Old versions in chat history are not recovery targets. Preserve and respect the deployment lease. Resolve unfinished operations using their existing identity and evidence before starting another.
For privacy quarantine, use only evidence-backed recovery on the verified unrestored primary: inspect current journal, receipt, database generation, exact branch/bindings/audit, drained writers, cleanup and capability fingerprints. Never clear quarantine manually, fabricate a receipt, infer rollback from a timeout, replay uncertain member mutations, reset credentials/sessions, or bypass privacy checks. Use current maintained tools. Retain ambiguous outcomes and reconcile them before retrying. Keep private evidence owner-only. Do not log secrets or member content. An operator transport must be removed and verified absent even after interruption.
The November 3 incident's legacy four-minute process wrapper timed out during journal verification. Use a measured bounded operator budget and reconcile transport/receipts after any timeout; do not weaken per-request or safety bounds. Preserve queue settings and resume delivery after successful recovery.
Do not induce production faults or run load tests. Do not deploy unrelated features, spend money, change providers, or send messages outside the selected GitHub incident channel. Use an isolated checkout for code fixes; retain source/schema/rollback compatibility and existing assets. Verify real login, authorized reads, logout/revocation, protected readiness, and at least 140 seconds of uninterrupted healthy monitor observations. Record the root cause, remaining uncertainty, actions and verification in this thread. If recovery requires information or permission you do not have, state the exact blocker. Do not create recurring ChatGPT polling or duplicate responder tasks.
Dispatch marker: porchday-incident:${incident.id}`;
}
/** Fixed-format observations only. No HTTP response bodies enter an agent prompt.
 * Dispatch is independent of GitHub delivery, and cannot slow the probe loop. */
export class IncidentDispatcher {
 private busy=false;
 constructor(private config:DispatchConfig,public current:Incident|undefined,private deps:Dependencies,private drill=false){validateDispatchConfig(config);}
 observe(observation:Observation){
  if(!Number.isFinite(Date.parse(observation.at))||observation.checks.some(c=>!checkNames.includes(c.name as typeof checkNames[number])))throw Error('INCIDENT_OBSERVATION_INVALID');
  let item=this.current;
  if(item&&Date.parse(observation.at)<=Date.parse(item.lastAt))return;
  if(!item||item.closedAt){
   if(observation.healthy)return;
   // An unfinished dispatch is retained through recovery; never lose an unknown
   // turn response by replacing its incident with a new one.
   if(item&&['creating','sending','uncertain'].includes(item.phase))return;
   item={v:1,id:this.deps.uuid(),at:observation.at,lastAt:observation.at,failures:0,failedChecks:[],phase:'watching',...(item?.threadId?{previousThreadId:item.threadId}:{})};
  }
  const contiguous=Date.parse(observation.at)-Date.parse(item.lastAt)<=45000;
  if(observation.healthy){
   if(!contiguous||!item.healthySince)item.healthySince=observation.at;
   if(Date.parse(observation.at)-Date.parse(item.healthySince)>=RECOVERY_STABILITY_MS)item.closedAt=observation.at;
   item.failures=0;
  }else{
   item.failures=(contiguous?item.failures:0)+1;delete item.healthySince;
   item.failedChecks=observation.checks.filter(c=>!c.ok).map(c=>c.name).sort();
  }
  item.lastAt=observation.at;this.current=item;this.deps.save(item);
  if(!observation.healthy&&item.failures>=2)void this.flush().catch(()=>{
   // A dispatcher state-disk failure must not reject the monitor's probe loop.
   try{this.deps.notify('incident_dispatch_needs_attention',item!.id);}catch{}
  });
 }
 async flush(){
  const item=this.current;if(this.busy||!item||item.closedAt)return;
  if(item.lastAttempt&&Date.now()-Date.parse(item.lastAttempt)<60000)return;
  this.busy=true;let rpc:Rpc|undefined;
  try{
   item.lastAttempt=new Date().toISOString();this.deps.save(item);
   rpc=await this.deps.connect();
   if(item.phase==='uncertain'){this.escalate(item);return;}
   if(item.phase==='accepted'){
    const value=await rpc.call('thread/read',{threadId:item.threadId,includeTurns:true});
    const turn=value.thread?.turns?.at(-1);
    // Completion of an agent turn is not service recovery. Continue normal
    // probes and explicitly alert owners if the responder stops while down.
    if(!turn||['completed','failed','interrupted'].includes(turn.status)||Date.now()-Date.parse(item.at)>15*60000)this.escalate(item);
    return;
   }
   // Never retransmit a turn after an ambiguous response. Reconcile the saved
   // thread instead. Empty orphan threads from a lost creation response cannot
   // execute work; creation ambiguity still requires explicit review.
   if(item.phase==='creating'||item.phase==='sending'){
    if(item.threadId){
     const value=await rpc.call('thread/read',{threadId:item.threadId,includeTurns:true});
     const turns=value.thread?.turns??[];
     if(turns.length){item.phase='accepted';item.turnId=turns.at(-1).id;delete item.error;this.deps.save(item);this.deps.notify('incident_reconciled',item.id);return;}
    }
    item.phase='uncertain';item.error='INCIDENT_DISPATCH_UNCONFIRMED';this.deps.save(item);this.deps.notify('incident_dispatch_uncertain',item.id);return;
   }
   if(item.phase==='watching'){
    if(item.previousThreadId){
     const prior=await rpc.call('thread/read',{threadId:item.previousThreadId,includeTurns:true});
     const turn=prior.thread?.turns?.at(-1);
     if(turn?.status==='inProgress'){
      item.threadId=item.previousThreadId;item.turnId=turn.id;item.phase='accepted';this.deps.save(item);this.deps.notify('incident_coalesced',item.id);return;
     }
    }
    item.phase='creating';this.deps.save(item);
    const result=await rpc.call('thread/start',{cwd:this.config.cwd,approvalPolicy:'never',sandbox:this.drill?'read-only':'danger-full-access',ephemeral:false});
    const id=result.thread?.id;if(typeof id!=='string'||!uuid.test(id))throw Error('INCIDENT_THREAD_INVALID');
    item.threadId=id;item.phase='ready';this.deps.save(item);
   }
   item.phase='sending';this.deps.save(item);
   const result=await rpc.call('turn/start',{threadId:item.threadId,clientUserMessageId:item.id,input:[{type:'text',text:incidentPrompt(item,this.config.cwd,this.drill)}]});
   if(typeof result.turn?.id!=='string')throw Error('INCIDENT_TURN_INVALID');
   item.turnId=result.turn.id;item.phase='accepted';delete item.error;this.deps.save(item);this.deps.notify('incident_dispatched',item.id);
  }catch{
   item.error='INCIDENT_DISPATCH_FAILED';this.deps.save(item);this.escalate(item);
  }finally{rpc?.close();this.busy=false;}
 }
 private escalate(item:Incident){
  if(item.lastEscalation&&Date.now()-Date.parse(item.lastEscalation)<15*60000)return;
  item.lastEscalation=new Date().toISOString();this.deps.save(item);this.deps.notify('incident_dispatch_needs_attention',item.id);
 }
}
export function createIncidentDispatcher(config:DispatchConfig,directory:string,notify:Dependencies['notify'],drill=false){
 validateDispatchConfig(config);privateDirectory(directory);let current:Incident|undefined;
 try{current=JSON.parse(privateFile(join(directory,'current.json')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('INCIDENT_STATE_INVALID');}
 if(current&&(current.v!==1||!uuid.test(current.id)||!['watching','creating','ready','sending','accepted','uncertain'].includes(current.phase)||!Number.isFinite(Date.parse(current.lastAt))||!Number.isSafeInteger(current.failures)||!Array.isArray(current.failedChecks)||current.failedChecks.some(c=>!checkNames.includes(c as typeof checkNames[number]))))throw Error('INCIDENT_STATE_INVALID');
 return new IncidentDispatcher(config,current,{uuid:randomUUID,notify,save:item=>{atomicJson(join(directory,item.id+'.json'),item);atomicJson(join(directory,'current.json'),item);},connect:async()=>{const rpc=new IncidentCodex(config.codexPath);try{await rpc.initialize();return rpc;}catch(error){rpc.close();throw error;}}},drill);
}
