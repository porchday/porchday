// Authorized synthetic staging session only. Never emit cookies or API bodies.
import {createHash} from 'node:crypto';
const origin='https://staging.porchday.com',cookie=process.env.PORCHDAY_STAGING_LATENCY_COOKIE,label=process.env.PORCHDAY_LATENCY_LABEL??'baseline';
if(!cookie||/[\r\n]/.test(cookie)||!['baseline','edge','placed','repeat'].includes(label))throw Error('PROBE_INPUT_INVALID');
const security=['content-security-policy','cross-origin-opener-policy','cross-origin-resource-policy','permissions-policy','referrer-policy','strict-transport-security','x-content-type-options','x-dns-prefetch-control','x-download-options','x-frame-options','x-permitted-cross-domain-policies','x-xss-protection'];
let location={country:'unknown',region:'unknown',city:'unknown'};
try{const r=await fetch('https://ipinfo.io/json',{redirect:'error',signal:AbortSignal.timeout(10000)});if(r.ok){const j=await r.json();for(const k of Object.keys(location))if(typeof j[k]==='string'&&/^[A-Za-z .-]{1,80}$/.test(j[k]))location[k]=j[k];}}catch{}
const paths=['/api/v1/me?bootstrap=1','/api/v1/feed?limit=10','/app-shell','/color-scheme.js'];
try{
 const health=await(await fetch(origin+'/health',{redirect:'error',signal:AbortSignal.timeout(15000)})).json();if(!/^[a-f0-9-]{36}$/.test(health.release))throw Error('RELEASE');
 const results=paths.map(path=>({path,samples:[],publicHashes:[],securityHeaders:[]}));
 for(let n=0;n<21;n++)for(const result of results){
  const api=result.path.startsWith('/api/'),start=performance.now();
  const r=await fetch(origin+result.path,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000),headers:api?{Cookie:cookie,Origin:origin}:{}});
  const body=await r.arrayBuffer(),total=Math.round(performance.now()-start);
  if(r.status!==200||(api&&!r.headers.get('cache-control')?.includes('no-store')))throw Error('RESPONSE_'+r.status);
  const edge=r.headers.get('cf-ray')?.split('-').at(-1);if(!/^[A-Z]{3}$/.test(edge??''))throw Error('EDGE');
  const timing=r.headers.get('server-timing');if(timing&&!/^[a-z0-9_;=.,\s-]+$/.test(timing))throw Error('TIMING');
  if(n)result.samples.push({total,edge,...(timing?{timing}:{})});
  if(!api){const hash=createHash('sha256').update(Buffer.from(body)).digest('hex');if(!result.publicHashes.includes(hash))result.publicHashes.push(hash);const headers=Object.fromEntries(security.map(k=>[k,r.headers.get(k)]));if(security.some(k=>!headers[k]))throw Error('SECURITY_HEADER');if(!result.securityHeaders.some(h=>JSON.stringify(h)===JSON.stringify(headers)))result.securityHeaders.push(headers);}
 }
 const end=await(await fetch(origin+'/health',{redirect:'error',signal:AbortSignal.timeout(15000)})).json();if(end.release!==health.release)throw Error('RELEASE_CHANGED');
 for(const r of results){const t=r.samples.map(s=>s.total).sort((a,b)=>a-b);r.p50=(t[9]+t[10])/2;r.p95=t[18];}
 console.log('STAGING_LATENCY_RESULT='+JSON.stringify({label,location,locationEvidence:'IP geolocation is approximate; per-request Cloudflare edge also recorded',release:health.release,results}));
}catch{console.log('STAGING_LATENCY_FAILED');process.exitCode=1;}
