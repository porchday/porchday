import {expect,test,vi} from 'vitest';
import {runCommandWithContinuity,type ContinuityCommandEvent} from './release-continuity-command';
const target={environment:'staging' as const,memberId:'00000000-0000-4000-8000-000000000001',cookie:'session=allowed-private',deniedCookie:'session=denied-private',healthToken:'private-health-token'};
const signal=()=>new AbortController().signal;
function fixture(){
 const events:ContinuityCommandEvent[]=[];
 const fetch=vi.fn(async(input:any,init:any)=>{
  const path=new URL(String(input)).pathname;
  if(path.endsWith('/health'))return Response.json({status:'ok',issues:[]});
  if(path.endsWith('/feed'))return Response.json({items:[]},{headers:{'cache-control':'no-store'}});
  return init.headers.Cookie===target.cookie?Response.json({id:target.memberId},{headers:{'cache-control':'no-store'}}):Response.json({}, {status:401});
 });
 const options={target,fetch:fetch as typeof globalThis.fetch,assertScope:()=>{},intervalMs:1000,maxSamples:5,retain:async(e:ContinuityCommandEvent)=>{events.push(e);},runCommand:vi.fn(async()=> 'complete' as const)};
 return {options,events,fetch};
}

test('retains baseline and intent before dispatch, then two samples starting after command completion',async()=>{
 const {options,events}=fixture();
 options.runCommand.mockImplementation(async()=>{
  expect(events.map(e=>e.kind)).toEqual(['sample','command-intent']);
  expect(events[0]).toMatchObject({phaseAtStart:'baseline',sample:{healthy:true}});
  return 'complete';
 });
 const result=await runCommandWithContinuity(options,signal());
 expect(result).toMatchObject({status:'complete',samples:3,failedSamples:0,postCommandSamples:2});
 expect(options.runCommand).toHaveBeenCalledTimes(1);
 const terminal=events.find(e=>e.kind==='command-terminal')!;
 const post=events.filter(e=>e.kind==='sample'&&e.phaseAtStart==='command-terminal');
 expect(post).toHaveLength(2);
 for(const e of post)if(e.kind==='sample'&&terminal.kind==='command-terminal')expect(Date.parse(e.sample.at)).toBeGreaterThanOrEqual(Date.parse(terminal.at));
 for(const secret of Object.values(target))if(secret!=='staging')expect(JSON.stringify(events)).not.toContain(secret);
});

test.each(['unhealthy','sample-sink','intent-sink','scope'] as const)('pre-dispatch %s failure prevents the command',async failure=>{
 const {options,fetch,events}=fixture();
 if(failure==='unhealthy')fetch.mockImplementation(async()=>Response.json({}, {status:503}));
 if(failure==='scope')options.assertScope=()=>{throw Error('SCOPE_LOST');};
 if(failure.endsWith('sink'))options.retain=async e=>{events.push(e);if(e.kind===(failure==='sample-sink'?'sample':'command-intent'))throw Error('SINK_FAILED');};
 await expect(runCommandWithContinuity(options,signal())).rejects.toThrow();
 expect(options.runCommand).not.toHaveBeenCalled();
});

test('a sample begun while command is running cannot count as a post-command sample',async()=>{
 const {options,events,fetch}=fixture(),normal=fetch.getMockImplementation()!;
 let finish!:()=>void;
 options.runCommand.mockImplementation(async()=>{await new Promise<void>(r=>{finish=r;});return 'complete';});
 let reads=0;
 fetch.mockImplementation(async(...args)=>{reads++;if(reads===5){finish();await new Promise(r=>setTimeout(r,10));}return normal(...args);});
 const result=await runCommandWithContinuity(options,signal());
 expect(result).toMatchObject({samples:4,postCommandSamples:2});
 expect(events.filter(e=>e.kind==='sample').map(e=>e.kind==='sample'&&e.phaseAtStart)).toEqual(['baseline','command-running','command-terminal','command-terminal']);
});

test('failed observation aborts and joins the running command before returning',async()=>{
 const {options,events}=fixture();let stopped=false;
 const runCommand=vi.fn(async(s:AbortSignal)=>{
  await new Promise<void>(r=>s.addEventListener('abort',()=>{setTimeout(()=>{stopped=true;r();},20);},{once:true}));
  return 'attention-required' as const;
 });
 options.retain=async e=>{events.push(e);if(e.kind==='sample'&&e.index===1)throw Error('SINK_FAILED');};
 await expect(runCommandWithContinuity({...options,runCommand},signal())).rejects.toThrow('SINK_FAILED');
 expect(stopped).toBe(true);expect(runCommand).toHaveBeenCalledTimes(1);
});

test('sample exhaustion aborts and joins instead of reporting empty recovery coverage',async()=>{
 const {options}=fixture();let stopped=false;
 const runCommand=vi.fn(async(s:AbortSignal)=>{await new Promise<void>(r=>s.addEventListener('abort',()=>{stopped=true;r();},{once:true}));return 'attention-required' as const;});
 await expect(runCommandWithContinuity({...options,maxSamples:3,runCommand},signal())).rejects.toThrow('CONTINUITY_COMMAND_SAMPLE_LIMIT');
 expect(stopped).toBe(true);expect(runCommand).toHaveBeenCalledTimes(1);
});

test('a failed sample remains a failure even when command and later samples succeed',async()=>{
 const {options,fetch}=fixture(),normal=fetch.getMockImplementation()!;let reads=0;
 fetch.mockImplementation(async(...args)=>++reads===5?Response.json({}, {status:503}):normal(...args));
 await expect(runCommandWithContinuity(options,signal())).rejects.toThrow('CONTINUITY_SAMPLES_FAILED');
 expect(options.runCommand).toHaveBeenCalledTimes(1);
});

test('command rejection is retained without raw errors and is never retried',async()=>{
 const {options,events}=fixture();options.runCommand.mockRejectedValue(Error('private transport credential'));
 await expect(runCommandWithContinuity(options,signal())).rejects.toThrow('CONTINUITY_COMMAND_UNVERIFIED');
 expect(options.runCommand).toHaveBeenCalledTimes(1);expect(events).toContainEqual(expect.objectContaining({kind:'command-terminal',status:'failed'}));
 expect(JSON.stringify(events)).not.toContain('private transport credential');
});

test('compatible rollback is distinguished from successful promotion',async()=>{
 const {options}=fixture();
 expect(await runCommandWithContinuity({...options,runCommand:async()=> 'rolled-back'},signal())).toMatchObject({status:'rolled-back',postCommandSamples:2});
});

test('caller cancellation joins the dispatched command and cannot produce acceptance',async()=>{
 const {options}=fixture(),controller=new AbortController();let stopped=false;
 const runCommand=vi.fn(async(s:AbortSignal)=>{
  const done=new Promise<void>(r=>s.addEventListener('abort',()=>{stopped=true;r();},{once:true}));
  controller.abort();await done;return 'attention-required' as const;
 });
 await expect(runCommandWithContinuity({...options,runCommand},controller.signal)).rejects.toThrow();
 expect(stopped).toBe(true);expect(runCommand).toHaveBeenCalledTimes(1);
});

test('failure to retain terminal evidence cannot be accepted',async()=>{
 const {options,events}=fixture();
 options.retain=async e=>{events.push(e);if(e.kind==='command-terminal')throw Error('TERMINAL_SINK_FAILED');};
 await expect(runCommandWithContinuity(options,signal())).rejects.toThrow('TERMINAL_SINK_FAILED');
 expect(options.runCommand).toHaveBeenCalledTimes(1);
});

test.each([{maxSamples:2},{intervalMs:999}])('rejects invalid observation bounds before reads or writes: %j',async bounds=>{
 const {options,fetch}=fixture();
 await expect(runCommandWithContinuity({...options,...bounds},signal())).rejects.toThrow('CONTINUITY_COMMAND_SCOPE');
 expect(fetch).not.toHaveBeenCalled();expect(options.runCommand).not.toHaveBeenCalled();
});


test.each(['DEPLOYMENT_READER_FLOOR_NOT_ACKNOWLEDGED','RELEASE_CI_NOT_SUCCESSFUL'])('retains known rejection %s without replaying the command',async code=>{
 const {options,events}=fixture();options.runCommand.mockRejectedValue(Error(code));
 await expect(runCommandWithContinuity(options,signal())).rejects.toThrow('CONTINUITY_COMMAND_UNVERIFIED');
 expect(options.runCommand).toHaveBeenCalledTimes(1);
 expect(events).toContainEqual(expect.objectContaining({kind:'command-terminal',status:'failed',failureCode:code}));
 expect(events.filter(e=>e.kind==='sample'&&e.phaseAtStart==='command-terminal')).toHaveLength(2);
});
test.each([Error('SECRET_TOKEN_ABC'),Error('DEPLOYMENT_READER_FLOOR_NOT_ACKNOWLEDGED: secret'),{message:'DEPLOYMENT_READER_FLOOR_NOT_ACKNOWLEDGED'},Object.defineProperty(new Error(),'message',{get(){throw Error('secret getter');}})])('redacts unknown or misleading diagnostic values',async error=>{
 const {options,events}=fixture();options.runCommand.mockRejectedValue(error);
 await expect(runCommandWithContinuity(options,signal())).rejects.toThrow('CONTINUITY_COMMAND_UNVERIFIED');
 expect(options.runCommand).toHaveBeenCalledTimes(1);
 expect(events).toContainEqual(expect.objectContaining({kind:'command-terminal',status:'failed',failureCode:'COMMAND_ERROR_REDACTED'}));
 expect(JSON.stringify(events)).not.toMatch(/SECRET_TOKEN_ABC|secret getter|: secret/);
});
