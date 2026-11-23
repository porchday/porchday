import {createAgentInbox} from './incident-inbox.ts';
import {reviewNotifications} from './incident-review.ts';
import {sessionReconciliation} from './external-monitor-reconciliation';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {probe,validateProbeConfig,type ProbeConfig} from './external-monitor-probe';
import {advanceActionable} from './external-monitor-alerts';
import {createRelayDrainer} from './external-monitor-delivery';
import {privateFile,privateDirectory,readState,persistState,record} from './external-monitor-store';
import {createIncidentDispatcher,type DispatchConfig} from './incident-dispatch.ts';

async function main(){
 const [configPath,directory,mode]=process.argv.slice(2);
 if(!configPath||!directory||!['--once','--continuous'].includes(mode))throw Error('MONITOR_ARGUMENTS');
 const config=JSON.parse(privateFile(resolve(configPath))) as ProbeConfig&{issue:number;incidentDispatch?:DispatchConfig;stagingInboxHealthToken?:string};validateProbeConfig(config);
 if(config.environment!=='production'||!Number.isSafeInteger(config.issue)||config.issue<1)throw Error('MONITOR_PRODUCTION_CONFIGURATION');
 const stateDirectory=resolve(directory);privateDirectory(stateDirectory);
 const sessionEvidence=sessionReconciliation(resolve(stateDirectory,'session-evidence'));
 let state=readState(stateDirectory),stopping=false;
 process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
 const save=()=>persistState(stateDirectory,state);
 const incidentNotice=(event:string,id:string)=>{
  console.log(JSON.stringify({at:new Date().toISOString(),event,incidentId:id}));
  // Durable review deadlines own escalation; dispatcher errors are not second outages.
 };
 let incidentDispatcher:ReturnType<typeof createIncidentDispatcher>|undefined;
 if(config.incidentDispatch)try{incidentDispatcher=createIncidentDispatcher(config.incidentDispatch,resolve(stateDirectory,'incidents'),incidentNotice);}
 catch{incidentNotice('incident_dispatch_needs_attention','configuration');}
 const inbox=createAgentInbox(config,stateDirectory,config.incidentDispatch?.codexPath);
 const stagingDirectory=resolve(stateDirectory,'inboxes','staging');
 if(config.stagingInboxHealthToken){if(config.stagingInboxHealthToken.length<32)throw Error('MONITOR_STAGING_INBOX_CONFIGURATION');privateDirectory(resolve(stateDirectory,'inboxes'));privateDirectory(stagingDirectory);}
 const stagingInbox=config.stagingInboxHealthToken?createAgentInbox({...config,environment:'staging',healthToken:config.stagingInboxHealthToken},stagingDirectory,config.incidentDispatch?.codexPath):undefined;
 const drainer=createRelayDrainer({issue:config.issue,read:()=>state,write:next=>{persistState(stateDirectory,next);state=next;},stopping:()=>stopping,
  notify:(event,kind)=>console.log(JSON.stringify({at:new Date().toISOString(),event,...(kind?{kind}:{})}))});
 const reviewAndDrain=()=>{
  const next=reviewNotifications(state,id=>JSON.parse(privateFile(resolve(stateDirectory,'incidents',id+'.json'))),Date.now());
  if(JSON.stringify(next)!==JSON.stringify(state)){state=next;save();}
  return drainer.flush();
 };
 const timer=mode==='--continuous'?setInterval(()=>{void reviewAndDrain();},5000):undefined;
 try{
 do{
  const started=Date.now();await sessionEvidence.reconcile();
  if(!sessionEvidence.available())throw Error('MONITOR_RECONCILIATION_CAPACITY');
  const responderError=!incidentDispatcher||!!incidentDispatcher.current?.error&&!incidentDispatcher.current.review;
  const [journey,aggregateChecks,stagingChecks]=await Promise.all([probe(config,{sessionEvidence}),inbox.poll(responderError),stagingInbox?.poll(responderError)??[]]);
  record(stateDirectory,journey); // Raw journey/SLO evidence never includes aggregate or staging alerts.
  const checks=[...journey.checks,...aggregateChecks,...stagingChecks.map(c=>({...c,name:'staging_'+c.name}))];
  const observation={...journey,checks,healthy:checks.every(c=>c.ok)};
  const previousIds=new Set(state.pending.map(e=>e.id)),previousFailures=new Set(state.observedSignatures??[]),wasIncident=state.incident;
  state=advanceActionable(state,observation,randomUUID());
  const failed=observation.checks.filter(c=>!c.ok&&c.failure!=='dependency'),signature=(c:typeof failed[number])=>c.name+':'+String(c.status??c.failure??'unknown');
  const newFailures=failed.filter(c=>!previousFailures.has(signature(c)));
  state.observedSignatures=observation.healthy?[]:[...new Set([...previousFailures,...failed.map(signature)])].slice(-128);
  if(wasIncident&&incidentDispatcher?.current?.review&&newFailures.length&&!state.pending.some(e=>!previousIds.has(e.id)))state.pending.push({id:randomUUID(),kind:'outage',at:observation.at,failedChecks:newFailures.map(c=>c.name),notice:'service'});
  for(const event of state.pending.filter(e=>!previousIds.has(e.id))){
   if(event.kind==='outage'){
    try{incidentDispatcher?.observe(observation,event.id,event.at);}catch{incidentNotice('incident_dispatch_needs_attention','state');}
    event.incidentId=event.id;state.incidentId=event.incidentId;
    const security=observation.checks.some(c=>c.name==='logout'&&c.ok)&&observation.checks.some(c=>c.name==='revocation'&&!c.ok&&c.status===200);
    if(security){state.ownerIncidents=[...(state.ownerIncidents??[]),event.incidentId].slice(-128);event.review={kind:'fallback',summary:'Access remained valid after an acknowledged logout. Immediate security escalation; investigation has been requested.'};}
    else event.reviewPending=true;
   }else if(state.incidentId){event.incidentId=state.incidentId;event.reviewPending=true;}
  }
  save();
  try{if(state.incident||observation.healthy||incidentDispatcher?.current?.reviewRequired)incidentDispatcher?.observe(observation);}catch{incidentNotice('incident_dispatch_needs_attention','state');}
  void reviewAndDrain();
  console.log(JSON.stringify({at:observation.at,event:'probe',healthy:journey.healthy,attentionRequired:!observation.healthy,durationMs:observation.durationMs,pendingNotifications:state.pending.length}));
  if(mode==='--once'){await drainer.flush();break;}
  // No overlapping probes and no catch-up burst after sleep, outage or restart.
  if(!stopping)await sleep(Math.max(0,20000-(Date.now()-started)));
 }while(!stopping);
 }finally{if(timer)clearInterval(timer);stopping=true;await drainer.flush();}
 if(mode==='--once'&&(state.incident||state.pending.length))process.exitCode=1;
}
main().catch(()=>{console.error('EXTERNAL_MONITOR_STOPPED');process.exitCode=1;});
