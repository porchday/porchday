import {describe,expect,it} from 'vitest';
import {deliver,type GitHubTransport} from './external-monitor-github';
import {alertBody,type AlertEvent} from './external-monitor-alerts';
const event:AlertEvent={id:'outage-one',kind:'outage',at:'2026-10-28T21:00:00.000Z',failedChecks:['login']};
const target={title:'External production availability alerts (operator-mac)'};
describe('GitHub owner alert delivery',()=>{
 it('reconciles a lost acknowledgement without sending a second notification',async()=>{
  const comments:unknown[]=[];let writes=0;
  const transport:GitHubTransport=async(method,path,body)=>{
   if(method==='POST'){writes++;comments.push(body);throw Error('lost successful reply');}
   return path.includes('/comments?')?comments:target;
  };
  await expect(deliver(123,event,'operator-mac',{transport})).rejects.toThrow();
  await deliver(123,event,'operator-mac',{transport});expect(writes).toBe(1);
 });
 it('searches earlier comments and never posts when the event already exists',async()=>{
  let pages=0,writes=0;
  const transport:GitHubTransport=async(method,path)=>{
   if(method==='POST'){writes++;return {};}
   if(!path.includes('/comments?'))return target;
   pages++;return pages===1?Array.from({length:100},()=>({body:'human context'})):[{body:alertBody(event,'operator-mac')}];
  };
  await deliver(123,event,'operator-mac',{transport});expect(pages).toBe(2);expect(writes).toBe(0);
 });
 it('refuses unrelated issues and forged conflicting event markers',async()=>{
  await expect(deliver(123,event,'operator-mac',{transport:async()=>({title:'Some other issue'})})).rejects.toThrow('MONITOR_ISSUE_MISMATCH');
  const transport:GitHubTransport=async(_,path)=>path.includes('/comments?')?[{body:alertBody(event,'operator-mac').split('\n')[0]+'\nnot the event'}]:target;
  await expect(deliver(123,event,'operator-mac',{transport})).rejects.toThrow('MONITOR_EVENT_CONFLICT');
 });
});
