import {expect,test,vi} from 'vitest';
import edge from '../src/edge';
import {app} from '../src/index';
import type {Env} from '../src/types';

const ctx={waitUntil:vi.fn(),passThroughOnException:vi.fn()} as unknown as ExecutionContext;
function environment(){
 const assets=vi.fn(async()=>new Response('public shell',{headers:{'Cache-Control':'public, max-age=0, must-revalidate','ETag':'"fixed"'}}));
 const backend=vi.fn(async()=>new Response('private reply',{headers:{'Cache-Control':'private, no-store','Server-Timing':'worker;dur=123','Set-Cookie':'test=renewed; Secure; HttpOnly'}}));
 const values={APP_URL:'https://porchday.org',LEGACY_APP_URL:'https://porchday.com',ENVIRONMENT:'production',ASSETS:{fetch:assets},API_BACKEND:{fetch:backend},CF_VERSION_METADATA:{id:'edge-version'},METRICS:undefined};
 const denied=vi.fn((key:PropertyKey)=>{throw Error('Unexpected private binding '+String(key));});
 const env=new Proxy(values,{get(target,key){return key in target?Reflect.get(target,key):denied(key);}});
 return {env:env as any,assets,backend,denied};
}
test('edge public routing preserves canonical, legacy, alias, HTTP and method behavior',async()=>{
 for(const host of ['https://porchday.org','https://porchday.com','https://www.porchday.org','https://www.porchday.com','http://porchday.com','https://untrusted.test']){
  for(const path of ['/','/login','/app-shell','/app/post/test','/privacy','/color-scheme.js'])for(const method of ['GET','HEAD','POST']){
   const {env,backend,denied}=environment();
   const actual=await edge.fetch(new Request(host+path+'?preserve=yes',{method}),env,ctx);
   const expected=await app.fetch(new Request(host+path+'?preserve=yes',{method}),env as Env,ctx);
   expect(actual.status).toBe(expected.status);
   for(const name of ['location','cache-control','etag','x-robots-tag','content-security-policy','referrer-policy','x-frame-options','strict-transport-security'])expect(actual.headers.get(name)).toBe(expected.headers.get(name));
   expect(await actual.text()).toBe(await expected.text());expect(backend).not.toHaveBeenCalled();expect(denied).not.toHaveBeenCalled();
  }
 }
});
test('API proxy preserves original URL, origin, cookies, authorization, method and streamed body once',async()=>{
 for(const path of ['/api','/api/v1/me?bootstrap=1','/api/v1/media','/.well-known/apple-app-site-association']){
  const {env,assets,backend,denied}=environment();
  const request=new Request('https://porchday.com'+path,{method:'POST',headers:{Origin:'https://porchday.com',Cookie:'synthetic=session',Authorization:'Bearer synthetic'},body:'streamed bytes'});
  const response=await edge.fetch(request,env,ctx);
  expect(backend).toHaveBeenCalledExactlyOnceWith(request);expect(await backend.mock.calls[0][0]!.text()).toBe('streamed bytes');
  expect(response.headers.get('server-timing')).toBe('worker;dur=123');expect(response.headers.get('set-cookie')).toContain('renewed');
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(assets).not.toHaveBeenCalled();expect(denied).not.toHaveBeenCalled();
 }
});
test('binding failures are sanitized, private and never retried',async()=>{
 const {env,backend}=environment();backend.mockRejectedValueOnce(Error('secret bearer value'));
 const r=await edge.fetch(new Request('https://porchday.org/api/v1/posts',{method:'POST',body:'ciphertext'}),env,ctx);
 expect(r.status).toBe(503);expect(r.headers.get('cache-control')).toBe('private, no-store');expect(await r.text()).not.toContain('secret');expect(backend).toHaveBeenCalledTimes(1);
});
test('public health remains at the edge without any backend/private dependency',async()=>{
 const {env,backend,assets,denied}=environment();const r=await edge.fetch(new Request('https://porchday.org/health'),env,ctx);
 expect((await r.json()).release).toBe('edge-version');expect(r.headers.get('cache-control')).toBe('no-store');expect(backend).not.toHaveBeenCalled();expect(assets).not.toHaveBeenCalled();expect(denied).not.toHaveBeenCalled();
});
