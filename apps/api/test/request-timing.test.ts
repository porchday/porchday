import {expect,test,vi} from 'vitest';
import {Hono} from 'hono';
import {RequestTiming,requestTimingMiddleware,measureJournalRead} from '../src/request-timing';
import {app} from '../src/index';
import type {Env,Variables} from '../src/types';

test('actual public health uses no external bindings and returns total Worker time only',async()=>{
 const external=vi.fn(()=>{throw Error('Unexpected external dependency');});
 const env=new Proxy({APP_URL:'https://porchday.org',LEGACY_APP_URL:'https://porchday.com',ENVIRONMENT:'production',CF_VERSION_METADATA:{id:'test-release'}}, {
  get(target,key){if(key in target)return Reflect.get(target,key);if(key==='METRICS')return undefined;return external();},
 }) as unknown as Env;
 const response=await app.request('https://porchday.org/health',{},env);
 expect(response.status).toBe(200);expect((await response.json()).release).toBe('test-release');
 expect(response.headers.get('server-timing')).toMatch(/^worker;dur=[0-9]+$/);
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect(external).not.toHaveBeenCalled();
});

test('timing is isolated per request and absent on other paths, methods, failures and unauthenticated me',async()=>{
 const router=new Hono<{Bindings:Env;Variables:Variables}>();router.use('*',requestTimingMiddleware);
 router.all('*',c=>{c.get('requestTiming')?.record('journal_db',7);return c.text('ok',c.req.query('fail')?503:200);});
 for(const [method,path] of [['GET','/other'],['POST','/health'],['GET','/api/v1/me'],['GET','/health?fail=1']]){
  const response=await router.request('https://example.test'+path,{method});expect(response.headers.has('server-timing')).toBe(false);
 }
 const a=new RequestTiming(),b=new RequestTiming();a.record('journal_db',12);
 expect(b.header()).toBe('');expect(a.header()).toBe('journal_db;dur=12');
 for(const duration of [-1,NaN,Infinity,3_600_001])a.record('worker',duration);
 a.record('private-token' as any,1);expect(a.header()).toBe('journal_db;dur=12');
});

test('journal timing preserves values and the original rejection',async()=>{
 const timing=new RequestTiming(),error=Error('private details');
 expect(await measureJournalRead(timing,'journal_r2',async()=>42)).toBe(42);
 await expect(measureJournalRead(timing,'journal_db',async()=>{throw error;})).rejects.toBe(error);
 expect(timing.header()).toMatch(/^journal_r2;dur=[0-9]+, journal_db;dur=[0-9]+$/);
});
