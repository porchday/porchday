import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {alertBody,type AlertEvent} from './external-monitor-alerts.ts';
import {deliver,type GitHubTransport} from './external-monitor-github.ts';

export async function relayNotification(eventId:string,payload:string,transport?:GitHubTransport):Promise<void>{
 if(payload.length>2048)throw Error('INVALID_RELAY_EVENT');
 const input=JSON.parse(payload) as {event:AlertEvent;drill:boolean};
 if(!input?.event||typeof input.drill!=='boolean'||input.event.id!==eventId)throw Error('INVALID_RELAY_EVENT');
 // The shared renderer validates fixed names and emits no caller-supplied prose.
 alertBody(input.event,'operator-mac',input.drill);
 await deliver(52,input.event,'operator-mac',{transport,drill:input.drill,requireBot:true});
}
async function main(){
 if(process.env.GITHUB_ACTIONS!=='true'||process.env.GITHUB_REPOSITORY!=='porchday/porchday'||process.env.GITHUB_REF!=='refs/heads/main'
  ||!['bobbyhwilder','andyk'].includes(process.env.GITHUB_ACTOR??''))throw Error('RELAY_CONTEXT');
 await relayNotification(process.env.PORCHDAY_MONITOR_EVENT_ID??'',process.env.PORCHDAY_MONITOR_RELAY_PAYLOAD??'');
 console.log('OWNER_NOTIFICATION_GITHUB_ACCEPTED');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('OWNER_NOTIFICATION_PENDING');process.exitCode=1;});
