import type {AlertEvent} from './external-monitor-alerts.ts';
import type {ProbeConfig} from './external-monitor-probe.ts';
export const inboxChannels=['availability','telemetry','latency','errors','authentication','recovery'] as const;
export type AgentInbox={enabled:true;lastAgentSeenAt:number|null;incidents:Array<{channel:typeof inboxChannels[number];at:number}>;backupSignal?:{id:string;at:string;kind:'outage'|'recovery';failedChecks:string[]}|null};
export async function readAgentInbox(config:ProbeConfig,ready?:boolean,request:typeof fetch=fetch):Promise<AgentInbox|undefined>{
 const origin=config.environment==='production'?'https://status.porchday.com':'https://staging-status.porchday.com';
 const response=await request(origin+'/agent-inbox',{method:ready===undefined?'GET':'POST',headers:{Authorization:'Bearer '+config.healthToken,'Content-Type':'application/json'},...(ready===undefined?{}:{body:JSON.stringify({ready})}),redirect:'manual',signal:AbortSignal.timeout(5000)});
 if(response.status===404){await response.body?.cancel();return undefined;}
 if(response.status!==200){await response.body?.cancel();throw Error('INCIDENT_INBOX_UNAVAILABLE');}
 const reader=response.body?.getReader();if(!reader)throw Error('INCIDENT_INBOX_UNAVAILABLE');let text='';
 try{for(;;){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);if(text.length>4096)throw Error('INCIDENT_INBOX_TOO_LARGE');}}finally{await reader.cancel();}
 const value=JSON.parse(text) as AgentInbox;
 if(value.enabled!==true||value.lastAgentSeenAt!==null&&(!Number.isSafeInteger(value.lastAgentSeenAt)||value.lastAgentSeenAt>Date.now()+30000)||!Array.isArray(value.incidents)||value.incidents.length>6||new Set(value.incidents.map(i=>i.channel)).size!==value.incidents.length||value.incidents.some(i=>!inboxChannels.includes(i.channel)||!Number.isSafeInteger(i.at)||i.at<0||i.at>Date.now()+30000))throw Error('INCIDENT_INBOX_INVALID');
 if(value.backupSignal&&(typeof value.backupSignal.id!=='string'||!/^[a-zA-Z0-9-]{1,64}$/.test(value.backupSignal.id)||!Number.isFinite(Date.parse(value.backupSignal.at))||!['outage','recovery'].includes(value.backupSignal.kind)||!Array.isArray(value.backupSignal.failedChecks)||value.backupSignal.failedChecks.some(c=>typeof c!=='string'||c.length>64)))throw Error('INCIDENT_INBOX_INVALID');
 return value;
}
export async function handoffBackup(config:ProbeConfig,event:AlertEvent):Promise<boolean|undefined>{
 const inbox=await readAgentInbox(config);if(!inbox)return undefined;
 const origin=config.environment==='production'?'https://status.porchday.com':'https://staging-status.porchday.com';
 const r=await fetch(origin+'/agent-signal',{method:'POST',headers:{Authorization:'Bearer '+config.healthToken,'Content-Type':'application/json'},body:JSON.stringify({id:event.id,at:event.at,kind:event.kind,failedChecks:event.failedChecks}),redirect:'manual',signal:AbortSignal.timeout(5000)});
 if(!r.ok){await r.body?.cancel();return false;}const result=await r.json() as {accepted?:boolean;receiverReady?:boolean};return result.accepted===true&&result.receiverReady===true;
}
