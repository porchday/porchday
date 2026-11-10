import {Hono} from 'hono';
import {it,expect,vi} from 'vitest';
import {createCausalInspector} from '../src/causal-inspector';
import type {Env,Variables} from '../src/types';
it('refuses collection when disabled',async()=>{const app=createCausalInspector();expect((await app.request('/recent',{},{} as Env)).status).toBe(503);});
it('requires a successful audit before returning operational evidence',async()=>{
 const reads=vi.fn(),audit=vi.fn(()=>Promise.reject(Error('audit unavailable'))),app=new Hono<{Bindings:Env;Variables:Variables}>();app.use('*',async(c,next)=>{c.set('staffSubject','synthetic-operator');await next();});app.route('/',createCausalInspector());app.onError(()=>new Response('unavailable',{status:503}));
 const db={prepare:vi.fn((sql:string)=>({bind:()=>({run:sql.startsWith('INSERT')?audit:reads,all:reads})})),batch:reads};
 const response=await app.request('/trace/'+'a'.repeat(32),{},{OPERATIONAL_TRACING:'true',TRACES:db} as unknown as Env);expect(response.status).toBe(503);expect(audit).toHaveBeenCalledOnce();expect(reads).not.toHaveBeenCalled();
});
it('rejects malformed trace IDs before issuing SQL',async()=>{const prepare=vi.fn(),app=createCausalInspector();expect((await app.request('/trace/not-a-trace',{},{OPERATIONAL_TRACING:'true',TRACES:{prepare}} as unknown as Env)).status).toBe(400);expect(prepare).not.toHaveBeenCalled();});
