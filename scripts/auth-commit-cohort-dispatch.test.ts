import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dispatchAuthCommitCohort} from './auth-commit-cohort-dispatch';

const directories:string[]=[];
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
function setup(count=2){
 const directory=mkdtempSync(join(tmpdir(),'porchday-cohort-'));directories.push(directory);
 const fixtures=Array.from({length:count},(_,index)=>({memberId:crypto.randomUUID(),sessionId:crypto.randomUUID(),cookie:`owned-cookie-${index}`}));
 const controller=new AbortController();let posts=0;let release:()=>void=()=>{};const barrier=new Promise<void>(resolve=>{release=resolve;});
 const transport=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
  expect(String(url).startsWith('https://staging.porchday.com/')).toBe(true);expect(init?.redirect).toBe('error');
  if(init?.method==='POST'){
   expect(readdirSync(directory).filter(n=>n.endsWith('-intent.json'))).toHaveLength(count+1);
   if(++posts===count)release();await barrier;await new Promise(resolve=>setTimeout(resolve,5));return new Response('{}',{status:200});
  }return new Response('{}',{status:401});
 });
 return{directory,fixtures,controller,options:{directory,fixtures,baselineSequence:'10',generation:crypto.randomUUID(),assertScope:vi.fn(),transport:transport as typeof fetch},transport};
}
it.each([2,4])('dispatches %i owned requests once with durable sanitized evidence',async count=>{
 const f=setup(count),windows=await dispatchAuthCommitCohort(f.options,f.controller.signal);
 expect(windows).toHaveLength(count);expect(f.transport).toHaveBeenCalledTimes(count*2);
 expect(Math.max(...windows.map(r=>r.startedAt))).toBeLessThan(Math.min(...windows.map(r=>r.endedAt)));
 for(const name of readdirSync(f.directory)){const text=readFileSync(join(f.directory,name),'utf8');expect(text).not.toContain('owned-cookie');expect(statSync(join(f.directory,name)).mode&0o777).toBe(0o600);}
 expect(JSON.parse(readFileSync(join(f.directory,'cohort-result.json'),'utf8'))).toMatchObject({canonicalProofVerified:false,automaticRetry:false});
 await expect(dispatchAuthCommitCohort(f.options,f.controller.signal)).rejects.toThrow('AUTH_COHORT_DISPATCH_UNVERIFIED');expect(f.transport).toHaveBeenCalledTimes(count*2);
});
it('never dispatches after a partial intent persistence failure',async()=>{
 const f=setup();writeFileSync(join(f.directory,'cohort-1-intent.json'),'existing');
 await expect(dispatchAuthCommitCohort(f.options,f.controller.signal)).rejects.toThrow('AUTH_COHORT_DISPATCH_UNVERIFIED');expect(f.transport).not.toHaveBeenCalled();
 expect(readFileSync(join(f.directory,'cohort-1-intent.json'),'utf8')).toBe('existing');
});
it.each(['count','member','session','cookie','newline','baseline','generation','abort','scope'])('rejects unsafe %s before dispatch',async kind=>{
 const f=setup();
 if(kind==='count')f.options.fixtures=f.fixtures.slice(0,1);
 if(kind==='member')f.fixtures[1].memberId=f.fixtures[0].memberId;
 if(kind==='session')f.fixtures[1].sessionId=f.fixtures[0].sessionId;
 if(kind==='cookie')f.fixtures[1].cookie=f.fixtures[0].cookie;
 if(kind==='newline')f.fixtures[0].cookie+='\n';
 if(kind==='baseline')f.options.baselineSequence='-1';
 if(kind==='generation')f.options.generation='bad';
 if(kind==='abort')f.controller.abort();
 if(kind==='scope')f.options.assertScope.mockImplementation(()=>{throw Error('private scope details');});
 await expect(dispatchAuthCommitCohort(f.options,f.controller.signal)).rejects.toThrow('AUTH_COHORT_DISPATCH_UNVERIFIED');expect(f.transport).not.toHaveBeenCalled();expect(readdirSync(f.directory)).toEqual([]);
});
it('waits for the other request after one unknown outcome and never retries',async()=>{
 const f=setup();let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;
 f.transport.mockImplementation(async(_url,init)=>{if(init?.method==='GET')return new Response('{}',{status:401});if(++calls===1)throw Error('private provider payload');await gate;return new Response('{}',{status:200});});
 let finished=false;const running=dispatchAuthCommitCohort(f.options,f.controller.signal).catch(error=>{finished=true;return error;});
 await new Promise(resolve=>setTimeout(resolve,10));expect(finished).toBe(false);release();expect((await running).message).toBe('AUTH_COHORT_DISPATCH_UNVERIFIED');expect(calls).toBe(2);
 expect(readdirSync(f.directory)).toContain('cohort-1-denial.json');expect(readdirSync(f.directory)).not.toContain('cohort-result.json');
 expect(readFileSync(join(f.directory,'cohort-0-unknown.json'),'utf8')).not.toContain('private');
});
it.each([500,401])('retains HTTP %i without retry or denial request',async status=>{
 const f=setup();f.transport.mockResolvedValue(new Response(null,{status}));
 await expect(dispatchAuthCommitCohort(f.options,f.controller.signal)).rejects.toThrow('AUTH_COHORT_DISPATCH_UNVERIFIED');expect(f.transport).toHaveBeenCalledTimes(2);expect(readdirSync(f.directory)).not.toContain('cohort-result.json');
});
it('rejects an accepted revoked cookie',async()=>{
 const f=setup(),original=f.transport.getMockImplementation()!;f.transport.mockImplementation(async(url,init)=>init?.method==='GET'?new Response(null,{status:200}):original(url,init));
 await expect(dispatchAuthCommitCohort(f.options,f.controller.signal)).rejects.toThrow('AUTH_COHORT_DISPATCH_UNVERIFIED');expect(f.transport).toHaveBeenCalledTimes(4);
});
it('bounds a transport that ignores abort, retaining unknown outcomes',async()=>{
 const f=setup();vi.useFakeTimers();f.transport.mockImplementation(()=>new Promise(()=>{}));
 // AbortSignal.timeout uses native timers; caller cancellation must also bound it.
 const running=dispatchAuthCommitCohort(f.options,f.controller.signal);const rejection=expect(running).rejects.toThrow('AUTH_COHORT_DISPATCH_UNVERIFIED');f.controller.abort();await rejection;
 expect(f.transport).toHaveBeenCalledTimes(2);expect(readdirSync(f.directory)).toContain('cohort-0-unknown.json');expect(readdirSync(f.directory)).toContain('cohort-1-unknown.json');
});
it('refuses success when scope changes after dispatched mutations',async()=>{
 const f=setup(),original=f.transport.getMockImplementation()!;f.transport.mockImplementation(async(url,init)=>{const response=await original(url,init);f.options.assertScope.mockImplementation(()=>{throw Error('changed');});return response;});
 await expect(dispatchAuthCommitCohort(f.options,f.controller.signal)).rejects.toThrow('AUTH_COHORT_DISPATCH_UNVERIFIED');expect(f.transport).toHaveBeenCalledTimes(2);expect(readdirSync(f.directory)).not.toContain('cohort-result.json');
});
it('enforces the ten-second deadline even if transport ignores its signal',async()=>{
 const f=setup();vi.useFakeTimers();vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{expect(ms).toBe(10000);const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
 f.transport.mockImplementation(()=>new Promise(()=>{}));const running=dispatchAuthCommitCohort(f.options,f.controller.signal);const rejection=expect(running).rejects.toThrow('AUTH_COHORT_DISPATCH_UNVERIFIED');
 await vi.advanceTimersByTimeAsync(10000);await rejection;expect(f.transport).toHaveBeenCalledTimes(2);
 expect(readdirSync(f.directory)).toContain('cohort-1-unknown.json');
});
it('retains a successful mutation when its denial observation is unknown',async()=>{
 const f=setup(),original=f.transport.getMockImplementation()!;f.transport.mockImplementation(async(url,init)=>{if(init?.method==='GET')throw Error('private transport detail');return original(url,init);});
 await expect(dispatchAuthCommitCohort(f.options,f.controller.signal)).rejects.toThrow('AUTH_COHORT_DISPATCH_UNVERIFIED');expect(f.transport).toHaveBeenCalledTimes(4);
 expect(JSON.parse(readFileSync(join(f.directory,'cohort-0-result.json'),'utf8')).status).toBe(200);expect(readdirSync(f.directory)).toContain('cohort-0-denial-unknown.json');
});
it('fails without further requests when outcome evidence cannot be retained',async()=>{
 const f=setup();writeFileSync(join(f.directory,'cohort-0-result.json'),'existing');
 await expect(dispatchAuthCommitCohort(f.options,f.controller.signal)).rejects.toThrow('AUTH_COHORT_DISPATCH_UNVERIFIED');expect(f.transport).toHaveBeenCalledTimes(3);
 expect(readFileSync(join(f.directory,'cohort-0-result.json'),'utf8')).toBe('existing');expect(readdirSync(f.directory)).toContain('cohort-1-denial.json');
});
