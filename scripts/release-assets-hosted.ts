import {createHash} from 'node:crypto';
import {chromium,type Browser,type Page,type Route} from 'playwright';
import {publicAssetManifestHash,validatePublicAssetManifest,type PublicAssetManifest} from './release-assets-verify.ts';
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const need=(value:unknown,code:string)=>{if(!value)throw Error(code);};
const maxBytes=25*1024*1024;
/** Only the previously observed optional analytics element is normalized. */
export function hostedDocumentMatches(bytes:Buffer,expected:string):boolean{
 if(bytes.length>maxBytes)return false;
 if(sha(bytes)===expected)return true;
 const text=bytes.toString(),pattern=/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[A-Za-z0-9]+" integrity="sha512-[A-Za-z0-9+/=]+" data-cf-beacon='[^<>\r\n]+' crossorigin="anonymous"><\/script>\n<\/body>/g;
 return [...text.matchAll(pattern)].length===1&&sha(text.replace(pattern,'</body>'))===expected;
}
function errors(page:Page){
 const counts={pageErrors:0,moduleMimeErrors:0};
 page.on('pageerror',()=>{counts.pageErrors++;});
 page.on('console',m=>{if(m.type()==='error'&&/MIME type|module script/i.test(m.text()))counts.moduleMimeErrors++;});
 return counts;
}
async function render(page:Page){
 await page.locator('input[type="password"]').waitFor({state:'visible',timeout:5000});
 return await page.locator('input[type="email"]').isVisible();
}
type Options={origin:string;baseline:PublicAssetManifest;candidate:PublicAssetManifest;signal?:AbortSignal;lifetimeMs?:number;
 /** Explicit staging drill: only the observer's fresh context receives a fault. */
 stagingFreshClientException?:true;
 /** Test ports; production uses fresh Chromium and normal fetch. */
 launch?:()=>Promise<Browser>;fetch?:typeof fetch};
/** Read-only two-phase observer. Prepare before activation; finish only after the
 * durable controller has reconciled the expected candidate. No deployment,
 * login, form submission, persistent profile or provider mutation occurs here.
 * The caller must persist both returned receipts and retain command failures.
 */
export async function beginHostedAssetTransition(input:Options){
 const options={...input,baseline:structuredClone(input.baseline),candidate:structuredClone(input.candidate)};
 const {origin,baseline,candidate}=options;
 need(['https://staging.porchday.com','https://porchday.org'].includes(origin),'HOSTED_ASSET_ORIGIN_INVALID');
 need(options.stagingFreshClientException===undefined||options.stagingFreshClientException===true&&origin==='https://staging.porchday.com','HOSTED_ASSET_DRILL_SCOPE_INVALID');
 validatePublicAssetManifest(baseline);validatePublicAssetManifest(candidate);
 need(baseline.files['index.html']&&candidate.files['index.html'],'HOSTED_ASSET_SHELL_REQUIRED');
 const lifetime=options.lifetimeMs??300000;need(Number.isInteger(lifetime)&&lifetime>=1&&lifetime<=600000,'HOSTED_ASSET_LIFETIME_INVALID');options.signal?.throwIfAborted();
 const browser=await(options.launch??(()=>chromium.launch({headless:true})))();
 let finished=false,closed:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const close=()=>{if(!closed){clearTimeout(timer);options.signal?.removeEventListener('abort',onAbort);closed=browser.close();}return closed;};
 const onAbort=()=>{void close().catch(()=>{});};
 const assertOpen=()=>{options.signal?.throwIfAborted();need(!closed&&browser.isConnected(),'HOSTED_ASSET_OBSERVER_CLOSED');};
 options.signal?.addEventListener('abort',onAbort,{once:true});timer=setTimeout(onAbort,lifetime);timer.unref();
 try{
  assertOpen();const context=await browser.newContext({serviceWorkers:'block'});
  const restrict=(route:Route)=>new URL(route.request().url()).origin===origin&&route.request().method()==='GET'?route.continue():route.abort();
  await context.route('**/*',restrict);const page=await context.newPage(),oldErrors=errors(page),requested=new Set<string>();
  page.on('request',r=>requested.add(new URL(r.url()).pathname));
  const response=await page.goto(origin+'/login',{waitUntil:'load',timeout:15000});
  need(response?.status()===200,'HOSTED_ASSET_BASELINE_STATUS');const html=await response!.body();
  need(hostedDocumentMatches(html,baseline.files['index.html']),'HOSTED_ASSET_BASELINE_BYTES');need(await render(page),'HOSTED_ASSET_BASELINE_RENDER');
  const entries=[...html.toString().matchAll(/src="(\/assets\/[A-Za-z0-9_-]+\.js)"/g)].map(m=>m[1]);need(entries.length===1&&baseline.files[entries[0].slice(1)],'HOSTED_ASSET_ENTRY_AMBIGUOUS');
  const fetchSignal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  const entryResponse=await(options.fetch??fetch)(origin+entries[0],{redirect:'error',signal:fetchSignal});
  need(entryResponse.status===200&&/^(text|application)\/javascript(?:;|$)/i.test(entryResponse.headers.get('content-type')??''),'HOSTED_ASSET_ENTRY_STATUS');
  need(entryResponse.body,'HOSTED_ASSET_ENTRY_BODY');const reader=entryResponse.body!.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const chunk=await reader.read();fetchSignal.throwIfAborted();if(chunk.done)break;size+=chunk.value.length;need(size<=maxBytes,'HOSTED_ASSET_ENTRY_LIMIT');chunks.push(chunk.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const entry=Buffer.concat(chunks);need(sha(entry)===baseline.files[entries[0].slice(1)],'HOSTED_ASSET_ENTRY_BYTES');
  const lazy=[...new Set([...entry.toString().matchAll(/import\("(\.\/[A-Za-z0-9_-]+\.js)"\)/g)].map(m=>'/assets/'+m[1].slice(2)))];
  need(lazy.length>0&&lazy.length<=100&&lazy.every(path=>!requested.has(path)&&baseline.files[path.slice(1)]),'HOSTED_ASSET_LAZY_NOT_COLD');
  need(lazy.every(path=>candidate.files[path.slice(1)]===baseline.files[path.slice(1)]),'HOSTED_ASSET_RETENTION_MISSING');
  need(oldErrors.pageErrors===0&&oldErrors.moduleMimeErrors===0,'HOSTED_ASSET_BASELINE_ERRORS');
  await page.getByLabel('Email address',{exact:true}).fill('retained-tab@example.test');assertOpen();
  const baselineReceipt={at:new Date().toISOString(),origin,baselineManifest:publicAssetManifestHash(baseline),candidateManifest:publicAssetManifestHash(candidate),lazyModules:lazy,oldErrors:{...oldErrors},serviceWorkers:'blocked',authenticated:false,...(options.stagingFreshClientException?{drill:'staging-fresh-client-exception' as const}:{})};
  return{baselineReceipt,assertOpen,close,async finish(){
   need(!finished,'HOSTED_ASSET_FINISH_ALREADY_STARTED');finished=true;
   try{
    assertOpen();const responses:Promise<{path:string;status:number;contentType:string;matchesBaseline:boolean}>[]=[];
    page.on('response',r=>{const path=new URL(r.url()).pathname;if(lazy.includes(path))responses.push(r.body().then(bytes=>({path,status:r.status(),contentType:(r.headers()['content-type']??'').split(';')[0].trim().toLowerCase(),matchesBaseline:bytes.length<=maxBytes&&sha(bytes)===baseline.files[path.slice(1)]})).catch(()=>({path,status:r.status(),contentType:'',matchesBaseline:false})));});
    // Import inside the browser, outside Node/test-runner module rewriting.
    // Paths came from the fixed asset regex and are encoded as JS string literals.
    let loadedModules=0;for(const path of lazy){assertOpen();if(await page.evaluate<boolean>(`import(${JSON.stringify(path)}).then(m=>typeof m.default==='function',()=>false)`))loadedModules++;}
    const oldDocumentRetained=await page.getByLabel('Email address',{exact:true}).inputValue()==='retained-tab@example.test'&&await page.locator('input[type="password"]').isVisible();
    const fresh=await browser.newContext({serviceWorkers:'block'});await fresh.route('**/*',restrict);const newPage=await fresh.newPage(),newErrors=errors(newPage);
    let drillExceptionObserved=false;
    if(options.stagingFreshClientException){
     newPage.on('pageerror',error=>{if(error.message==='PORCHDAY_STAGING_BROWSER_RECOVERY_DRILL')drillExceptionObserved=true;});
     await fresh.addInitScript(()=>{document.addEventListener('DOMContentLoaded',()=>{throw Error('PORCHDAY_STAGING_BROWSER_RECOVERY_DRILL');},{once:true});});
    }
    const next=await newPage.goto(origin+'/login',{waitUntil:'load',timeout:15000});
    const newDocumentMatches=next?.status()===200&&hostedDocumentMatches(await next.body(),candidate.files['index.html']);
    let newTabRendered=false;try{newTabRendered=await render(newPage);}catch{/* Preserve failed rendering in the receipt. */}
    const assets=await Promise.all(responses);assertOpen();
    const passed=oldDocumentRetained&&newDocumentMatches&&newTabRendered&&loadedModules===lazy.length&&assets.length===lazy.length&&new Set(assets.map(a=>a.path)).size===lazy.length&&assets.every(a=>a.status===200&&a.matchesBaseline&&['text/javascript','application/javascript'].includes(a.contentType))&&[oldErrors,newErrors].every(e=>e.pageErrors===0&&e.moduleMimeErrors===0);
    return{...baselineReceipt,at:new Date().toISOString(),passed,oldDocumentRetained,newDocumentMatches,newTabRendered,loadedModules,assets,oldErrors:{...oldErrors},newErrors:{...newErrors},...(options.stagingFreshClientException?{drillExceptionObserved}:{}),scope:'Unauthenticated cold lazy entrypoints in an existing tab and fresh login rendering; no signed-in, full module graph, installed service-worker or native-client proof.'};
   }finally{await close();}
  }};
 }catch(error){await close();throw error;}
}
