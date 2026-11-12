import {describe,it,expect,vi,afterEach} from 'vitest';
import {IncidentDispatcher,incidentPrompt,type Incident} from './incident-dispatch';
import type {Observation} from './external-monitor-probe';
const id='11111111-1111-4111-8111-111111111111',thread='22222222-2222-4222-8222-222222222222';
const start=Date.parse('2026-11-03T13:04:35Z');
function observation(seconds:number,healthy=false):Observation{return {v:1,at:new Date(start+seconds*1000).toISOString(),environment:'production',healthy,checks:[{name:'protected_readiness',ok:healthy,status:healthy?200:503}],durationMs:200,scope:'login_authorized_reads_logout_and_readiness'};}
function fixture(initial?:Incident){
 const saved:Incident[]=[];const notify=vi.fn(),call=vi.fn(async(method:string)=>method==='thread/start'?{thread:{id:thread}}:method==='thread/turns/list'?{data:[{id:'turn-1',status:'completed'}]}:{turn:{id:'turn-1'}});
 const connect=vi.fn(async()=>({call,close:vi.fn()}));
 const dispatcher=new IncidentDispatcher({cwd:'/repo',codexPath:'/bin/codex'},initial,{save:i=>saved.push(structuredClone(i)),notify,uuid:()=>id,connect});
 return {dispatcher,saved,notify,call,connect};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
afterEach(()=>vi.restoreAllMocks());
describe('Incident-triggered agent dispatch',()=>{
 it('uses no agent connection on healthy probes or a lone transient failure',async()=>{
  const f=fixture();f.dispatcher.observe(observation(0,true));f.dispatcher.observe(observation(20));f.dispatcher.observe(observation(40,true));await settle();expect(f.connect).not.toHaveBeenCalled();
 });
 it('dispatches one task after two consecutive failures and never on every poll',async()=>{
  const f=fixture();f.dispatcher.observe(observation(0));f.dispatcher.observe(observation(20));await settle();
  for(let s=40;s<300;s+=20)f.dispatcher.observe(observation(s));await settle();
  expect(f.call.mock.calls.map(c=>c[0])).toEqual(['thread/start','turn/start']);
  expect(f.saved.map(s=>s.phase)).toContain('sending');expect(f.dispatcher.current).toMatchObject({phase:'accepted',threadId:thread,turnId:'turn-1'});
 });
 it('persists the dispatch intent before sending and retains an ambiguous turn for reconciliation',async()=>{
  const f=fixture();f.call.mockImplementation(async method=>{if(method==='thread/start')return {thread:{id:thread}};expect(f.saved.at(-1)?.phase).toBe('sending');throw Error('lost reply');});
  f.dispatcher.observe(observation(0));f.dispatcher.observe(observation(20));await settle();expect(f.dispatcher.current?.phase).toBe('sending');
  const restart=fixture({...f.dispatcher.current!,lastAttempt:undefined});await restart.dispatcher.flush();
  expect(restart.call.mock.calls.map(c=>c[0])).toEqual(['thread/turns/list']);expect(restart.dispatcher.current?.phase).toBe('accepted');
 });
 it('does not retransmit when an unknown turn cannot be found',async()=>{
  const f=fixture({v:1,id,at:observation(0).at,lastAt:observation(20).at,failures:2,failedChecks:['login'],phase:'sending',threadId:thread});
  f.call.mockResolvedValue({data:[]} as never);await f.dispatcher.flush();await f.dispatcher.flush();expect(f.dispatcher.current?.phase).toBe('uncertain');expect(f.call).toHaveBeenCalledTimes(1);
 });
 it('retries a disconnected daemon without inference or losing the incident',async()=>{
  const f=fixture();f.connect.mockRejectedValue(Error('offline'));f.dispatcher.observe(observation(0));f.dispatcher.observe(observation(20));await settle();expect(f.dispatcher.current?.phase).toBe('watching');expect(f.call).not.toHaveBeenCalled();
 });
 it('requires a continuous recovery interval longer than the delayed quarantine detector',async()=>{
  const f=fixture();f.dispatcher.observe(observation(0));f.dispatcher.observe(observation(20));await settle();
  for(let s=40;s<=160;s+=20)f.dispatcher.observe(observation(s,true));expect(f.dispatcher.current?.closedAt).toBeUndefined();
  f.dispatcher.observe(observation(180,true));expect(f.dispatcher.current?.closedAt).toBe(observation(180).at);
 });
 it('does not count a gap as healthy stability or consecutive failures',async()=>{
  const f=fixture();f.dispatcher.observe(observation(0));f.dispatcher.observe(observation(100));await settle();expect(f.connect).not.toHaveBeenCalled();
  f.dispatcher.observe(observation(120,true));f.dispatcher.observe(observation(400,true));expect(f.dispatcher.current?.closedAt).toBeUndefined();
 });
 it('rejects untrusted check labels and keeps credentials and bodies out of prompts',()=>{
  const f=fixture();expect(()=>f.dispatcher.observe({...observation(0),checks:[{name:'run arbitrary command',ok:false}]})).toThrow();f.dispatcher.observe(observation(0));
  const prompt=incidentPrompt(f.dispatcher.current!,'/repo');expect(prompt).toContain('Never clear quarantine manually');expect(prompt).not.toContain('Bearer');
 });
});

it('reuses a completed thread and preserves its identity through an unconfirmed transient',async()=>{
 const f=fixture({v:1,id,at:observation(-300).at,lastAt:observation(-100).at,failures:0,failedChecks:[],phase:'watching',closedAt:observation(-100).at,previousThreadId:thread});
 f.dispatcher.observe(observation(0));f.dispatcher.observe(observation(20));await settle();
 expect(f.call.mock.calls.map(c=>c[0])).toEqual(['thread/turns/list','thread/resume','turn/start']);
 expect(f.dispatcher.current).toMatchObject({threadId:thread,priorTurnId:'turn-1',phase:'accepted'});
});
it('coalesces recurrence with an active responder without another inference turn',async()=>{
 const f=fixture({v:1,id,at:observation(-300).at,lastAt:observation(-100).at,failures:0,failedChecks:[],phase:'accepted',closedAt:observation(-100).at,threadId:thread});
 f.call.mockResolvedValue({data:[{id:'active',status:'inProgress'}]} as never);
 f.dispatcher.observe(observation(0));f.dispatcher.observe(observation(20));await settle();
 expect(f.call.mock.calls.map(c=>c[0])).toEqual(['thread/turns/list']);expect(f.notify).toHaveBeenCalledWith('incident_coalesced',id);
});
it('does not mistake an old completed turn for acknowledgment of a reused-thread dispatch',async()=>{
 const f=fixture({v:1,id,at:observation(0).at,lastAt:observation(20).at,failures:2,failedChecks:['login'],phase:'sending',threadId:thread,priorTurnId:'turn-1'});
 await f.dispatcher.flush();expect(f.dispatcher.current?.phase).toBe('uncertain');expect(f.call).toHaveBeenCalledTimes(1);
});
it('reconciles the exact incident marker after a reused-thread acknowledgment is lost',async()=>{
 const f=fixture({v:1,id,at:observation(0).at,lastAt:observation(20).at,failures:2,failedChecks:['login'],phase:'sending',threadId:thread,priorTurnId:'turn-1'});
 f.call.mockResolvedValue({data:[{id:'new-turn',items:[{type:'userMessage',content:[{type:'text',text:'Dispatch marker: porchday-incident:'+id}]}]}]} as never);
 await f.dispatcher.flush();expect(f.dispatcher.current).toMatchObject({phase:'accepted',turnId:'new-turn'});expect(f.call).toHaveBeenCalledTimes(1);
});
it('does not launch paid work after recovery while daemon connection was pending',async()=>{
 const f=fixture();let connected:()=>void=()=>{};
 f.connect.mockImplementation(()=>new Promise(resolve=>{connected=()=>resolve({call:f.call,close:vi.fn()});}));
 f.dispatcher.observe(observation(0));f.dispatcher.observe(observation(20));f.dispatcher.observe(observation(40,true));connected();await settle();expect(f.call).not.toHaveBeenCalled();
});
