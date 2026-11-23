import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {atomicJson} from './external-monitor-store.ts';
import type {IncidentCodex} from './incident-codex.ts';
import type {ProbeConfig,Check} from './external-monitor-probe.ts';
import {readAgentInbox,inboxChannels,type AgentInbox} from './incident-inbox-client.ts';
/** All polling here is ordinary network/file work, never model inference. */
export function createAgentInbox(config:ProbeConfig,directory:string,codexPath?:string){
 let ready=false,nextReadiness=0,checking=false,last:AgentInbox|undefined,lastRead=0,signature='';
 return {async poll(responderError=false):Promise<Check[]>{
  if(codexPath&&!checking&&Date.now()>=nextReadiness){
   checking=true;nextReadiness=Date.now()+60000;
   void (async()=>{let rpc:IncidentCodex|undefined;try{const {IncidentCodex}=await import('./incident-codex.ts');rpc=await IncidentCodex.connect(codexPath);ready=true;}catch{ready=false;}finally{rpc?.close();checking=false;}})();
  }
  try{const value=await readAgentInbox(config,ready&&!responderError);if(value){last=value;lastRead=Date.now();const nextSignature=JSON.stringify({incidents:value.incidents,backupSignal:value.backupSignal});if(signature!==nextSignature){appendFileSync(join(directory,'operator-inbox-history.jsonl'),JSON.stringify({at:new Date(lastRead).toISOString(),...JSON.parse(nextSignature)})+'\n',{mode:0o600});signature=nextSignature;}atomicJson(join(directory,'operator-inbox.json'),{...value,receivedAt:new Date(lastRead).toISOString(),responderReady:ready&&!responderError});}else return [];}
  catch{if(!last)return [];}
  if(Date.now()-lastRead>120000)return [{name:'incident_inbox',ok:false,failure:'transport_or_response'}];
  return [...inboxChannels.map(channel=>({name:'aggregate_'+channel,ok:!last!.incidents.some(i=>i.channel===channel),status:200})),{name:'backup_observation',ok:!(last!.backupSignal?.kind==='outage'&&Date.now()-Date.parse(last!.backupSignal.at)<15*60000),status:200}];
 }};
}
