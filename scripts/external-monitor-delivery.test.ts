import {describe,it,expect} from 'vitest';
import {createRelayDrainer} from './external-monitor-delivery.ts';
import {alertBody,initialState,type AlertState,type AlertEvent} from './external-monitor-alerts.ts';
import type {GitHubTransport} from './external-monitor-github.ts';
const outage:AlertEvent={id:'outage',kind:'outage',at:'2026-10-28T23:00:00.000Z',failedChecks:['login']};
const recovery:AlertEvent={id:'recovery',kind:'recovery',at:'2026-10-28T23:00:20.000Z',failedChecks:[]};
function fixture(){
 let state:AlertState={...initialState(),pending:[outage]},clock=Date.parse(outage.at),posts=0,gets=0,failRead=false,failSave=false;const delivered:AlertEvent[]=[],calls:string[]=[];
 const transport:GitHubTransport=async(method,path,body)=>{
  if(method==='GET'){gets++;if(failRead)throw Error('GITHUB_REQUEST_FAILED');return path.includes('/comments?')?delivered.map(e=>({body:alertBody(e,'operator-mac'),user:{login:'github-actions[bot]',type:'Bot'}})):{title:'External production availability alerts (operator-mac)'};}
  calls.push('post');posts++;const event=JSON.parse((body as {inputs:{payload:string}}).inputs.payload).event;expect(state.lastRelayAttempt?.id).toBe(event.id);return null;
 };
 const options={issue:52,read:()=>state,write:(value:AlertState)=>{if(failSave)throw Error('disk failure');calls.push('save');state=value;},stopping:()=>false,notify:()=>{},now:()=>clock,transport};
 return{options,delivered,calls,state:()=>state,append:()=>{state={...state,pending:[...state.pending,recovery]};},time:(milliseconds:number)=>{clock+=milliseconds;},readFails:(value:boolean)=>{failRead=value;},saveFails:(value:boolean)=>{failSave=value;},posts:()=>posts,gets:()=>gets};
}
describe('relay scheduling',()=>{
 it('marks explicit drills in dispatch and requires the matching drill acknowledgement',async()=>{
  const f=fixture();let acknowledged=false;
  const transport:GitHubTransport=async(method,path,body)=>{
   if(method==='GET')return path.includes('/comments?')?[{body:alertBody(outage,'operator-mac',acknowledged),user:{login:'github-actions[bot]',type:'Bot'}}]:{title:'External production availability alerts (operator-mac)'};
   expect(JSON.parse((body as {inputs:{payload:string}}).inputs.payload).drill).toBe(true);return null;
  };
  const d=createRelayDrainer({...f.options,drill:true,transport});await d.flush();expect(f.state().pending).toHaveLength(1);acknowledged=true;f.time(5000);await d.flush();expect(f.state().pending).toEqual([]);
 });
 it('retries a failed GET promptly without consuming a dispatch cooldown',async()=>{
  const f=fixture(),d=createRelayDrainer(f.options);f.readFails(true);await d.flush();expect(f.posts()).toBe(0);expect(f.state().lastRelayAttempt).toBeUndefined();f.readFails(false);f.time(4999);await d.flush();expect(f.posts()).toBe(0);f.time(1);await d.flush();expect(f.posts()).toBe(1);expect(f.calls.indexOf('save')).toBeLessThan(f.calls.indexOf('post'));
 });
 it('polls for delivery without another POST and then dispatches queued recovery immediately',async()=>{
  const f=fixture(),d=createRelayDrainer(f.options);await d.flush();f.append();f.time(5000);await d.flush();expect(f.posts()).toBe(1);expect(f.state().pending).toHaveLength(2);f.delivered.push(outage);f.time(5000);await d.flush();expect(f.posts()).toBe(2);expect(f.state().pending).toEqual([recovery]);f.delivered.push(recovery);f.time(5000);await d.flush();expect(f.state().pending).toEqual([]);expect(f.state().lastRelayAttempt).toBeUndefined();
 });
 it('preserves the uncertain dispatch cooldown across restart and bounds redispatch',async()=>{
  const f=fixture();await createRelayDrainer(f.options).flush();const resumed=createRelayDrainer(f.options);f.time(10000);await resumed.flush();expect(f.posts()).toBe(1);f.time(49999);await resumed.flush();expect(f.posts()).toBe(1);f.time(5001);await resumed.flush();expect(f.posts()).toBe(2);
 });
 it('does not dispatch when durable attempt recording fails',async()=>{
  const f=fixture(),d=createRelayDrainer(f.options);f.saveFails(true);await d.flush();expect(f.posts()).toBe(0);expect(f.state().pending).toEqual([outage]);
 });
 it('serializes overlapping flushes and preserves observations appended during delivery',async()=>{
  const f=fixture();let unblock!:()=>void;const gate=new Promise<void>(resolve=>{unblock=resolve;});const transport:GitHubTransport=async(...args)=>{await gate;return f.options.transport(...args);};const d=createRelayDrainer({...f.options,transport});const first=d.flush(),second=d.flush();expect(first).toBe(second);f.append();unblock();await first;expect(f.posts()).toBe(1);expect(f.state().pending).toEqual([outage,recovery]);
 });
});
