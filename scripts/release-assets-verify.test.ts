import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {verifyPublicAssets,publicAssetManifestHash,validatePublicAssetReport} from './release-assets-verify.ts';
const sha=(body:string)=>createHash('sha256').update(body).digest('hex');
const source='a'.repeat(40),origin='https://staging.porchday.com';
describe('public release asset verification',()=>{
 it('pins manifest content independently of key order and rejects incomplete or duplicated proof',async()=>{
  const manifest={source,files:{'b.js':sha('module'),'a.js':sha('module')},retainedSources:['b'.repeat(40)]};
  expect(publicAssetManifestHash(manifest)).toBe(publicAssetManifestHash({...manifest,files:{'a.js':sha('module'),'b.js':sha('module')}}));
  expect(publicAssetManifestHash(manifest)).not.toBe(publicAssetManifestHash({...manifest,retainedSources:[]}));
  const report=await verifyPublicAssets(origin,manifest,{fetch:async()=>new Response('module',{headers:{'content-type':'text/javascript'}})});expect(()=>validatePublicAssetReport(origin,manifest,report)).not.toThrow();
  for(const checks of [report.checks.slice(0,1),[report.checks[0],report.checks[0]],report.checks.map(c=>({...c,contentType:'text/html'}))])expect(()=>validatePublicAssetReport(origin,manifest,{...report,checks})).toThrow('PROOF_INVALID');
 });
 it('requires the exact bytes and executable content type, not merely HTTP 200',async()=>{
  const result=await verifyPublicAssets(origin,{source,files:{'assets/old.js':sha('module'),'assets/current.js':sha('module'),'assets/wrong.js':sha('module')}},{fetch:async input=>new Response(String(input).includes('old.js')?'<html>':String(input).includes('wrong.js')?'changed':'module',{headers:{'content-type':String(input).includes('old.js')?'text/html':'text/javascript; charset=utf-8'}})});
  expect(result.healthy).toBe(false);expect(result.checks.map(c=>[c.path,c.code])).toEqual([['assets/current.js','ok'],['assets/old.js','content_type'],['assets/wrong.js','hash']]);
 });
 it('maps the shell route and excludes provider-only headers from public requests',async()=>{
  const urls:string[]=[];
  const result=await verifyPublicAssets(origin,{source,files:{'index.html':sha('shell'),'app-shell.html':sha('shell'),'_headers':sha('headers')}},{fetch:async(input,init)=>{urls.push(String(input));expect(init?.redirect).toBe('error');return new Response('shell',{headers:{'content-type':'text/html'}});}});
  expect(result.healthy).toBe(true);expect(urls).toEqual([origin+'/app-shell',origin+'/app-shell']);expect(result.skipped).toEqual(['_headers']);
 });
 it('retains failed statuses and transport failures alongside successful checks',async()=>{
  const result=await verifyPublicAssets(origin,{source,files:{'a.js':sha('a'),'b.js':sha('b'),'c.js':sha('c')}},{fetch:async input=>{if(String(input).endsWith('/a.js'))throw Error('private transport detail');return new Response('c',{status:String(input).endsWith('/b.js')?503:200,headers:{'content-type':'application/javascript'}});}});
  expect(result.checks.map(c=>c.code)).toEqual(['transport','status','ok']);expect(JSON.stringify(result)).not.toContain('private transport detail');
 });
 it('bounds concurrent reads and never starts reads after cancellation',async()=>{
  let active=0,maximum=0,calls=0;const files=Object.fromEntries(Array.from({length:9},(_,i)=>[`assets/${i}.js`,sha('module')]));
  const fetcher:typeof fetch=async()=>{calls++;active++;maximum=Math.max(maximum,active);await new Promise(done=>setTimeout(done,1));active--;return new Response('module',{headers:{'content-type':'text/javascript'}});};
  expect((await verifyPublicAssets(origin,{source,files},{fetch:fetcher})).healthy).toBe(true);expect(maximum).toBe(4);expect(calls).toBe(9);
  const controller=new AbortController();controller.abort();const result=await verifyPublicAssets(origin,{source,files},{fetch:fetcher,signal:controller.signal});expect(result.checks.every(c=>c.code==='aborted')).toBe(true);expect(calls).toBe(9);
 });
 it('rejects unexpected origins, paths and unsupported types before requests',async()=>{
  let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw Error('unexpected');};
  for(const path of ['../secret','assets/../../secret','/a.js','a.js?x','a.unknown'])await expect(verifyPublicAssets(origin,{source,files:{[path]:sha('a')}},{fetch:fetcher})).rejects.toThrow();
  await expect(verifyPublicAssets('https://elsewhere.invalid',{source,files:{'a.js':sha('a')}},{fetch:fetcher})).rejects.toThrow('INVALID_RELEASE_ORIGIN');expect(calls).toBe(0);
 });
 it('cancels an oversized streamed body without reporting a matching asset',async()=>{
  let cancelled=false;const chunk=new Uint8Array(1024*1024);
  const result=await verifyPublicAssets(origin,{source,files:{'a.js':sha('a')}},{fetch:async()=>new Response(new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(chunk);},cancel(){cancelled=true;}}),{headers:{'content-type':'text/javascript'}})});
  expect(result.healthy).toBe(false);expect(result.checks[0].code).toBe('body_limit');expect(result.checks[0].sha256).toBeUndefined();expect(cancelled).toBe(true);
 });
});
