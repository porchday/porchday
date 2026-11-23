import {parseReview,reviewSchema,type IncidentReview} from './incident-review.ts';
import {randomUUID} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {atomicJson,privateDirectory,privateFile} from './external-monitor-store.ts';
import {checkNames} from './external-monitor-alerts.ts';
import type {Observation} from './external-monitor-probe.ts';
import {IncidentCodex} from './incident-codex.ts';

export type DispatchConfig={cwd:string;codexPath:string};
export type Incident={v:1;id:string;at:string;lastAt:string;failures:number;failedChecks:string[];healthySince?:string;closedAt?:string;
 phase:'watching'|'creating'|'ready'|'sending'|'accepted'|'uncertain';threadId?:string;turnId?:string;previousThreadId?:string;previousIncidentId?:string;priorTurnId?:string;lastAttempt?:string;lastEscalation?:string;error?:string;reviewRequired?:boolean;review?:IncidentReview};
type Rpc={call(method:string,params:any):Promise<any>;close():void};
type Dependencies={connect:()=>Promise<Rpc>;save:(incident:Incident)=>void;notify:(event:string,id:string)=>void;uuid:()=>string;completePrevious?:(id:string,turn:any,rpc:Rpc)=>Promise<void>};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const RECOVERY_STABILITY_MS=140000;
export function validateDispatchConfig(value:DispatchConfig){
 if(!value||!isAbsolute(value.cwd)||!isAbsolute(value.codexPath))throw Error('INCIDENT_DISPATCH_CONFIGURATION');
}
export function incidentPrompt(incident:Incident,cwd:string,drill=false){
 if(drill&&incident.reviewRequired)return `Read-only Porchday agent-first dispatch verification. This is a simulated trigger, NOT an outage. Do not change files or production, induce failures, send messages, or create issues. Read ${cwd}/docs/incident-dispatch.md and inspect only the last eight fixed-format observations in /Users/bobby/.config/porchday-external-monitor/state/observations-2026-11.jsonl. Never read credentials or member data. Return the required JSON for incidentId ${incident.id}, decision not_incident, with a short sanitized summary and evidence that this is a drill and the observed status. Do not investigate unrelated work. Dispatch marker: porchday-incident:${incident.id}`;

 return `Porchday incident response — ${incident.failedChecks.join(', ')}\n${drill?'Notification drill: perform read-only checks only. Do not change production, create incidents, or send messages.':'The owner has authorized this automatically dispatched Porchday incident task to investigate and restore service without waiting for a chat message.'}
Incident ID: ${incident.id}. First observed: ${incident.at}. Failed checks: ${incident.failedChecks.join(', ')}.
Work from ${cwd}. Begin with fresh public session checks, protected readiness and the independent monitor evidence, including ~/.config/porchday-external-monitor/state/operator-inbox.json and state/inboxes/staging/operator-inbox.json for environment-specific Cloudflare aggregate alert channels. Treat this alert as a trigger, not proof that service is still down. Recovery is not resolution. Investigate the triggering interval even if healthy now; correlate retained observations, service traces, deployments and monitor-path evidence, establish the cause as far as evidence permits, and remediate within authorization. Verify at least 140 seconds of stable recovery; do not change production speculatively.
Read docs/incident-response.md, docs/restore-safety.md, docs/deployment-recovery.md, and docs/incident-dispatch.md. Discover the current canonical deployment and active operation under /Users/bobby/Development/inner-circle/artifacts/private. Old versions in chat history are not recovery targets. Preserve and respect the deployment lease. Resolve unfinished operations using their existing identity and evidence before starting another.
For privacy quarantine, use only evidence-backed recovery on the verified unrestored primary: inspect current journal, receipt, database generation, exact branch/bindings/audit, drained writers, cleanup and capability fingerprints. Never clear quarantine manually, fabricate a receipt, infer rollback from a timeout, replay uncertain member mutations, reset credentials/sessions, or bypass privacy checks. Use current maintained tools. Retain ambiguous outcomes and reconcile them before retrying. Keep private evidence owner-only. Do not log secrets or member content. An operator transport must be removed and verified absent even after interruption.
The November 3 incident's legacy four-minute process wrapper timed out during journal verification. Use a measured bounded operator budget and reconcile transport/receipts after any timeout; do not weaken per-request or safety bounds. Preserve queue settings and resume delivery after successful recovery.
Do not induce production faults or run load tests. Do not deploy unrelated features, spend money, change providers, or send messages outside the selected GitHub incident channel. Use an isolated checkout for code fixes; retain source/schema/rollback compatibility and existing assets. Verify real login, authorized reads, logout/revocation, protected readiness, and at least 140 seconds of uninterrupted healthy monitor observations. Record the root cause, remaining uncertainty, actions and verification in this thread. If recovery requires information or permission you do not have, state the exact blocker. Do not create recurring ChatGPT polling or duplicate responder tasks.
${incident.reviewRequired?`Agent-first notification policy: the owner has NOT been paged yet (except a security or watchdog fallback). You own this investigation. Do not send email, issue comments, mentions, or other owner notifications directly. Return the required JSON disposition for incidentId ${incident.id}: resolved only after a verified fix/recovery; not_incident only with evidence that no service problem existed; notify for confirmed impact or an operator action the owner should know about; blocked when investigation/remediation cannot safely complete. Include a concise sanitized summary and concrete evidence references. Do not equate a current healthy probe with root-cause resolution. The monitor records your result privately and sends one owner alert only for notify/blocked or its bounded fallback. No credentials, cookies, member data, or private content in the summary. Continue authorized remediation until completed or precisely blocked.`:''}
Dispatch marker: porchday-incident:${incident.id}`;
}
/** Fixed-format observations only. No HTTP response bodies enter an agent prompt.
 * Dispatch is independent of GitHub delivery, and cannot slow the probe loop. */
export class IncidentDispatcher {
 private busy=false;
 constructor(private config:DispatchConfig,public current:Incident|undefined,private deps:Dependencies,private drill=false){validateDispatchConfig(config);}
 observe(observation:Observation,reviewId?:string,reviewAt?:string){
  if(!Number.isFinite(Date.parse(observation.at))||observation.checks.some(c=>!checkNames.includes(c.name as typeof checkNames[number])))throw Error('INCIDENT_OBSERVATION_INVALID');
  let item=this.current;
  if(item&&Date.parse(observation.at)<=Date.parse(item.lastAt))return;
  if(!item||item.closedAt||reviewId&&item.review){
   if(observation.healthy){if(item?.reviewRequired&&!item.review)void this.flush().catch(()=>{});return;}
   // An unfinished dispatch is retained through recovery; never lose an unknown
   // turn response by replacing its incident with a new one.
   if(item&&['creating','sending','uncertain'].includes(item.phase))return;
   item={v:1,id:reviewId??this.deps.uuid(),...(reviewId?{reviewRequired:true}:{}),at:reviewAt??observation.at,lastAt:observation.at,failures:0,failedChecks:[],phase:'watching',...((item?.threadId||item?.previousThreadId)?{previousThreadId:item.threadId||item.previousThreadId,previousIncidentId:item.id}:{})};
  }
  if(reviewId)item.reviewRequired=true;
  const contiguous=Date.parse(observation.at)-Date.parse(item.lastAt)<=45000;
  if(observation.healthy){
   if(!contiguous||!item.healthySince)item.healthySince=observation.at;
   if(Date.parse(observation.at)-Date.parse(item.healthySince)>=RECOVERY_STABILITY_MS)item.closedAt=observation.at;
   item.failures=0;
  }else{
   item.failures=Math.max(reviewId?2:0,(contiguous?item.failures:0)+1);delete item.healthySince;delete item.closedAt;
   item.failedChecks=observation.checks.filter(c=>!c.ok).map(c=>c.name).sort();
  }
  item.lastAt=observation.at;this.current=item;this.deps.save(item);
  if((!observation.healthy&&item.failures>=2)||item.reviewRequired&&!item.review)void this.flush().catch(()=>{
   // A dispatcher state-disk failure must not reject the monitor's probe loop.
   try{this.deps.notify('incident_dispatch_needs_attention',item!.id);}catch{}
  });
 }
 async flush(){
  const item=this.current;if(this.busy||!item||item.review||item.closedAt&&!item.reviewRequired)return;
  if(item.lastAttempt&&Date.now()-Date.parse(item.lastAttempt)<60000)return;
  this.busy=true;let rpc:Rpc|undefined;
  try{
   item.lastAttempt=new Date().toISOString();this.deps.save(item);
   rpc=await this.deps.connect();
   if(!item.reviewRequired&&(item.closedAt||item.failures<2)&&!['creating','sending'].includes(item.phase))return;
   if(item.phase==='uncertain'){this.escalate(item);return;}
   if(item.phase==='accepted'){
    const value=await rpc.call('thread/turns/list',{threadId:item.threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
    const turn=value.data?.find((t:any)=>t.id===item.turnId);
    if(item.reviewRequired&&turn?.status==='completed'){
     try{item.review=await completedReview(item,turn,rpc);delete item.error;this.deps.save(item);this.deps.notify('incident_review_completed',item.id);return;}
     catch{item.error='INCIDENT_REVIEW_INVALID';this.deps.save(item);this.escalate(item);return;}
    }
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
     const value=await rpc.call('thread/turns/list',{threadId:item.threadId,limit:1,sortDirection:'desc',itemsView:'full'});
     const turns=value.data??[];
     const dispatched=turns.find((turn:any)=>turn.id!==item.priorTurnId&&turn.items?.some((entry:any)=>entry.type==='userMessage'&&entry.content?.some((part:any)=>part.type==='text'&&part.text?.includes('Dispatch marker: porchday-incident:'+item.id))));
     // Legacy incidents created a new empty thread, so any turn was theirs.
     const confirmed=dispatched||(!item.priorTurnId?turns.at(-1):undefined);
     if(confirmed){item.phase='accepted';item.turnId=confirmed.id;delete item.error;this.deps.save(item);this.deps.notify('incident_reconciled',item.id);return;}
    }
    item.phase='uncertain';item.error='INCIDENT_DISPATCH_UNCONFIRMED';this.deps.save(item);this.deps.notify('incident_dispatch_uncertain',item.id);return;
   }
   if(!item.reviewRequired&&(item.closedAt||item.failures<2))return;
   if(item.phase==='watching'){
    if(item.previousThreadId){
     const prior=await rpc.call('thread/turns/list',{threadId:item.previousThreadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
     const turn=prior.data?.[0];
     if(turn?.status==='inProgress'){
      if(item.reviewRequired)return; // Wait for the one existing responder; do not pretend it received this incident.
      item.threadId=item.previousThreadId;item.turnId=turn.id;item.phase='accepted';this.deps.save(item);this.deps.notify('incident_coalesced',item.id);return;
     }
     if(item.previousIncidentId)await this.deps.completePrevious?.(item.previousIncidentId,turn,rpc);
     // Load the existing durable conversation before beginning another turn.
     // Save the prior turn identity so a lost send reply cannot be mistaken for
     // an older completed incident in this now-reused thread.
     await rpc.call('thread/resume',{threadId:item.previousThreadId,excludeTurns:true,cwd:this.config.cwd,approvalPolicy:'never',sandbox:this.drill?'read-only':'danger-full-access'});
     item.threadId=item.previousThreadId;item.priorTurnId=turn?.id;item.phase='ready';this.deps.save(item);
    }else{
    if(!item.reviewRequired&&(item.closedAt||item.failures<2))return;
    item.phase='creating';this.deps.save(item);
    const result=await rpc.call('thread/start',{cwd:this.config.cwd,approvalPolicy:'never',sandbox:this.drill?'read-only':'danger-full-access',ephemeral:false});
    const id=result.thread?.id;if(typeof id!=='string'||!uuid.test(id))throw Error('INCIDENT_THREAD_INVALID');
    item.threadId=id;item.phase='ready';this.deps.save(item);
    }
   }
   if(!item.reviewRequired&&(item.closedAt||item.failures<2))return;
   item.phase='sending';this.deps.save(item);
   const result=await rpc.call('turn/start',{threadId:item.threadId,clientUserMessageId:item.id,...(item.reviewRequired?{outputSchema:reviewSchema}:{}),input:[{type:'text',text:incidentPrompt(item,this.config.cwd,this.drill)}]});
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
async function completedReview(item:Incident,turn:any,rpc:Rpc):Promise<IncidentReview>{
 if(turn?.id!==item.turnId||turn?.status!=='completed')throw Error('INCIDENT_REVIEW_NOT_COMPLETE');
 let messages=turn.items?.filter((i:any)=>i.type==='agentMessage'&&typeof i.text==='string');
 if(!messages){const page=await rpc.call('thread/items/list',{threadId:item.threadId,turnId:item.turnId,limit:10,sortDirection:'desc',deferOutput:{commandExecution:true,mcpToolCall:true}});messages=page.data?.filter((e:any)=>e.turnId===item.turnId&&e.item?.type==='agentMessage').map((e:any)=>e.item).reverse();}
 return parseReview(JSON.parse(messages?.at(-1)?.text??''),item.id);
}
export function createIncidentDispatcher(config:DispatchConfig,directory:string,notify:Dependencies['notify'],drill=false){
 validateDispatchConfig(config);privateDirectory(directory);let current:Incident|undefined;
 try{current=JSON.parse(privateFile(join(directory,'current.json')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('INCIDENT_STATE_INVALID');}
 if(current&&(current.v!==1||!uuid.test(current.id)||!['watching','creating','ready','sending','accepted','uncertain'].includes(current.phase)||!Number.isFinite(Date.parse(current.lastAt))||!Number.isSafeInteger(current.failures)||!Array.isArray(current.failedChecks)||current.failedChecks.some(c=>!checkNames.includes(c as typeof checkNames[number]))))throw Error('INCIDENT_STATE_INVALID');
 if(current?.review)parseReview(current.review,current.id);
 return new IncidentDispatcher(config,current,{uuid:randomUUID,notify,completePrevious:async(id,turn,rpc)=>{
  if(!uuid.test(id))throw Error('INCIDENT_PREVIOUS_INVALID');
  const path=join(directory,id+'.json'),previous=JSON.parse(privateFile(path)) as Incident;
  if(previous.reviewRequired&&!previous.review&&previous.phase==='accepted'&&turn?.id===previous.turnId&&turn.status==='completed'){
   try{previous.review=await completedReview(previous,turn,rpc);delete previous.error;}catch{previous.error='INCIDENT_REVIEW_INVALID';}
   atomicJson(path,previous);
  }
 },save:item=>{atomicJson(join(directory,item.id+'.json'),item);atomicJson(join(directory,'current.json'),item);},connect:()=>IncidentCodex.connect(config.codexPath)},drill);
}
