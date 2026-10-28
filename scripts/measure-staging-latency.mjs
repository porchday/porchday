// Authorized synthetic staging session only. Never emit cookies or API bodies.
import {createHash} from 'node:crypto';
const origin='https://staging.porchday.com',cookie=process.env.PORCHDAY_STAGING_LATENCY_COOKIE,label=process.env.PORCHDAY_LATENCY_LABEL??'baseline';
if(!cookie||/[\r\n]/.test(cookie)||!['baseline','edge','placed','repeat'].includes(label))throw Error('PROBE_INPUT_INVALID');
const security=['content-security-policy','cross-origin-opener-policy','cross-origin-resource-policy','permissions-policy','referrer-policy','strict-transport-security','x-content-type-options','x-dns-prefetch-control','x-download-options','x-frame-options','x-permitted-cross-domain-policies','x-xss-protection'];
let location={country:'unknown',region:'unknown',city:'unknown'};
try{const r=await fetch('https://ipinfo.io/json',{redirect:'error',signal:AbortSignal.timeout(10000)});if(r.ok){const j=await r.json();for(const k of Object.keys(location))if(typeof j[k]==='string'&&/^[A-Za-z .-]{1,80}$/.test(j[k]))location[k]=j[k];}}catch{}
const sampleCount=Number(process.env.PORCHDAY_LATENCY_SAMPLES??20);
if(!Number.isInteger(sampleCount)||sampleCount<1||sampleCount>100)throw Error('SAMPLE_COUNT_INVALID');
const paths=['/api/v1/me?bootstrap=1','/api/v1/feed?limit=10','/app-shell','/color-scheme.js'];
let stage='health_before',path='/health',httpStatus=null,completedSamples=0,attemptStarted=performance.now();
try{
 const healthResponse=await fetch(origin+'/health',{redirect:'error',signal:AbortSignal.timeout(15000)});httpStatus=healthResponse.status;if(httpStatus!==200)throw Error('RESPONSE_'+httpStatus);const health=await healthResponse.json();if(!/^[a-f0-9-]{36}$/.test(health.release))throw Error('RELEASE');
 const results=paths.map(path=>({path,samples:[],publicHashes:[],securityHeaders:[]}));
 for(let n=0;n<=sampleCount;n++)for(const result of results){
  path=result.path;stage='request_headers';httpStatus=null;attemptStarted=performance.now();
  const api=result.path.startsWith('/api/'),start=performance.now();
  const r=await fetch(origin+result.path,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000),headers:api?{Cookie:cookie,Origin:origin}:{}});
  httpStatus=r.status;stage='request_body';
  const body=await r.arrayBuffer(),total=Math.round(performance.now()-start);
  stage='response_validation';
  if(r.status!==200||(api&&!r.headers.get('cache-control')?.includes('no-store')))throw Error('RESPONSE_'+r.status);
  const edge=r.headers.get('cf-ray')?.split('-').at(-1);if(!/^[A-Z]{3}$/.test(edge??''))throw Error('EDGE');
  const timing=r.headers.get('server-timing');if(timing&&!/^[a-z0-9_;=.,\s-]+$/.test(timing))throw Error('TIMING');
  if(n)completedSamples++;
  if(n)result.samples.push({total,edge,...(timing?{timing}:{})});
  if(!api){const hash=createHash('sha256').update(Buffer.from(body)).digest('hex');if(!result.publicHashes.includes(hash))result.publicHashes.push(hash);const headers=Object.fromEntries(security.map(k=>[k,r.headers.get(k)]));if(security.some(k=>!headers[k]))throw Error('SECURITY_HEADER');if(!result.securityHeaders.some(h=>JSON.stringify(h)===JSON.stringify(headers)))result.securityHeaders.push(headers);}
 }
 stage='health_after';path='/health';httpStatus=null;attemptStarted=performance.now();
 const endResponse=await fetch(origin+'/health',{redirect:'error',signal:AbortSignal.timeout(15000)});httpStatus=endResponse.status;if(httpStatus!==200)throw Error('RESPONSE_'+httpStatus);const end=await endResponse.json();if(end.release!==health.release)throw Error('RELEASE_CHANGED');
 for(const r of results){const t=r.samples.map(s=>s.total).sort((a,b)=>a-b);r.p50=t.length%2?t[Math.floor(t.length/2)]:(t[t.length/2-1]+t[t.length/2])/2;r.p90=t[Math.ceil(t.length*.9)-1];r.p95=t[Math.ceil(t.length*.95)-1];}
 console.log('STAGING_LATENCY_RESULT='+JSON.stringify({label,location,locationEvidence:'IP geolocation is approximate; per-request Cloudflare edge also recorded',release:health.release,results}));
}catch(error){
 // Allowlisted causes only: never print exceptions, messages, URLs, headers,
 // response bodies, cookies, SQL, identifiers or credentials.
 const message=String(error?.message??'');
 const validation=/^(RELEASE|EDGE|TIMING|SECURITY_HEADER|RELEASE_CHANGED|RESPONSE_[0-9]{3})$/.test(message)?message:null;
 const name=['AbortError','TimeoutError','TypeError','SyntaxError'].includes(error?.name)?error.name:'Error';
 const code=['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error?.cause?.code)?error.cause.code:null;
 console.log('STAGING_LATENCY_FAILED='+JSON.stringify({stage,path,httpStatus,elapsedMs:Math.round(performance.now()-attemptStarted),completedSamples,validation,errorClass:name,transportCode:code}));process.exitCode=1;
}
