import {describe,expect,it} from 'vitest';
import {relayNotification} from './external-monitor-relay';
import {deliver,type GitHubTransport} from './external-monitor-github';
import {alertBody,type AlertEvent} from './external-monitor-alerts';
const event:AlertEvent={id:'relay-event',kind:'outage',at:'2026-10-28T21:00:00.000Z',failedChecks:['login']};
const bot={login:'github-actions[bot]',type:'Bot'};
describe('bot-authored owner notification relay',()=>{
 it('keeps delivery pending after dispatch and acknowledges only the exact bot comment',async()=>{
  const comments:{body:string;user:typeof bot}[]=[],dispatches:{ref:string;inputs:{event_id:string;payload:string}}[]=[];
  const transport:GitHubTransport=async(method,path,body)=>{
   if(method==='POST'&&path.endsWith('/dispatches')){dispatches.push(body as typeof dispatches[number]);return null;}
   if(method==='POST'){comments.push({...(body as {body:string}),user:bot});return {};}
   return path.includes('/comments?')?comments:{title:'External production availability alerts (operator-mac)'};
  };
  await expect(deliver(52,event,'operator-mac',{transport,relay:true})).rejects.toThrow('NOTIFICATION_PENDING');
  expect(comments).toHaveLength(0);expect(dispatches).toHaveLength(1);expect(dispatches[0].ref).toBe('main');
  await relayNotification(dispatches[0].inputs.event_id,dispatches[0].inputs.payload,transport);
  await deliver(52,event,'operator-mac',{transport,relay:true});
  await relayNotification(dispatches[0].inputs.event_id,dispatches[0].inputs.payload,transport);
  expect(dispatches).toHaveLength(1);expect(comments).toHaveLength(1);expect(comments[0].body).toContain('@andyk @bobbyhwilder');
 });
 it('does not mistake an owner-authored comment for bot delivery',async()=>{
  const comments=[{body:alertBody(event,'operator-mac'),user:{login:'bobbyhwilder',type:'User'}}];let writes=0;
  const transport:GitHubTransport=async(method,path,body)=>{
   if(method==='POST'){writes++;comments.push({...(body as {body:string}),user:bot});return {};}
   return path.includes('/comments?')?comments:{title:'External production availability alerts (operator-mac)'};
  };
  await relayNotification(event.id,JSON.stringify({event,drill:false}),transport);expect(writes).toBe(1);
  await deliver(52,event,'operator-mac',{transport,relay:true});expect(writes).toBe(1);
 });
 it('confines relays to the dedicated issue and rejects arbitrary caller prose',async()=>{
  const transport:GitHubTransport=async()=>{throw Error('NETWORK_MUST_NOT_RUN');};
  await expect(deliver(53,event,'operator-mac',{transport,relay:true})).rejects.toThrow('INVALID_RELAY_DESTINATION');
  for(const payload of [JSON.stringify({event:{...event,failedChecks:['private prose']},drill:false}),JSON.stringify({event,drill:'yes'}),'x'.repeat(2049)])
   await expect(relayNotification(event.id,payload,transport)).rejects.toThrow();
  await expect(relayNotification('other-id',JSON.stringify({event,drill:false}),transport)).rejects.toThrow('INVALID_RELAY_EVENT');
 });
 it('retains explicit drill labeling through dispatch and replay',async()=>{
  let body='';
  const transport:GitHubTransport=async(method,path,input)=>{
   if(method==='POST'){body=(input as {body:string}).body;return {};}
   return path.includes('/comments?')?[]:{title:'External production availability alerts (operator-mac)'};
  };
  await relayNotification(event.id,JSON.stringify({event,drill:true}),transport);expect(body).toContain('Notification drill');
 });
});
