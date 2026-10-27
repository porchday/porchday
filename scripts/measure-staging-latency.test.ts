import {expect,test} from 'vitest';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

function probe(mode:string){
 const preload=`globalThis.fetch=async(url)=>{
  if(String(url).includes('ipinfo'))return Response.json({country:'US',region:'California',city:'Pasadena'});
  if(String(url).endsWith('/health'))return Response.json({release:'11111111-1111-1111-1111-111111111111'});
  if(${JSON.stringify(mode)}==='network')throw Object.assign(new TypeError('super-secret-cookie private SQL'),{cause:{code:'ECONNRESET'}});
  if(${JSON.stringify(mode)}==='http')return new Response('private member content',{status:503});
  if(${JSON.stringify(mode)}==='body')return {status:200,headers:new Headers(),arrayBuffer:async()=>{throw Error('private body credentials')}};
  const security=['content-security-policy','cross-origin-opener-policy','cross-origin-resource-policy','permissions-policy','referrer-policy','strict-transport-security','x-content-type-options','x-dns-prefetch-control','x-download-options','x-frame-options','x-permitted-cross-domain-policies','x-xss-protection'];
  return new Response('synthetic',{headers:{...Object.fromEntries(security.map(k=>[k,'fixed'])),'cache-control':'private, no-store','cf-ray':'fake-LAX'}});
 };`;
 return spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),resolve('scripts/measure-staging-latency.mjs')],{
  encoding:'utf8',env:{PATH:process.env.PATH,PORCHDAY_STAGING_LATENCY_COOKIE:'super-secret-cookie',PORCHDAY_LATENCY_SAMPLES:'2'},timeout:10000,
 });
}
test.each(['network','http','body'])('probe reports bounded %s failure causes without sensitive values',mode=>{
 const r=probe(mode);expect(r.status).toBe(1);expect(r.stderr).toBe('');
 const output=r.stdout;expect(output).not.toMatch(/super-secret-cookie|private SQL|private member|credentials/);
 const value=JSON.parse(output.trim().split('STAGING_LATENCY_FAILED=')[1]);
 expect(value.path).toBe('/api/v1/me?bootstrap=1');expect(value.completedSamples).toBe(0);expect(value.elapsedMs).toBeGreaterThanOrEqual(0);
 if(mode==='network'){expect(value.stage).toBe('request_headers');expect(value.transportCode).toBe('ECONNRESET');}
 if(mode==='http'){expect(value.httpStatus).toBe(503);expect(value.validation).toBe('RESPONSE_503');}
 if(mode==='body')expect(value.stage).toBe('request_body');
});
test('probe records the requested sample count and percentile fields',()=>{
 const r=probe('success');expect(r.status).toBe(0);const value=JSON.parse(r.stdout.trim().split('STAGING_LATENCY_RESULT=')[1]);
 expect(value.results).toHaveLength(4);
 for(const result of value.results){expect(result.samples).toHaveLength(2);expect(result.p90).toBeGreaterThanOrEqual(result.p50);expect(result.p95).toBe(result.p90);}
});
