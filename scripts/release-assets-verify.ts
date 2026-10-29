import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {extname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export interface PublicAssetManifest {source:string;files:Record<string,string>;retainedSources?:string[]}
const types:Record<string,string[]>={'.html':['text/html'],'.js':['text/javascript','application/javascript'],'.mjs':['text/javascript','application/javascript'],'.css':['text/css'],'.svg':['image/svg+xml'],'.png':['image/png'],'.json':['application/json'],'.map':['application/json'],'.webmanifest':['application/manifest+json','application/json'],'.txt':['text/plain'],'.woff2':['font/woff2']};
export function validatePublicAssetManifest(manifest:PublicAssetManifest):void{
 if(!manifest||typeof manifest.source!=='string'||!/^[a-f0-9]{40}$/.test(manifest.source)||!manifest.files||Array.isArray(manifest.files)||typeof manifest.files!=='object')throw Error('INVALID_PUBLIC_MANIFEST');
 if(manifest.retainedSources!==undefined&&(!Array.isArray(manifest.retainedSources)||manifest.retainedSources.length>100||!manifest.retainedSources.every(source=>typeof source==='string'&&/^[a-f0-9]{40}$/.test(source))))throw Error('INVALID_PUBLIC_MANIFEST');
 const entries=Object.entries(manifest.files).sort(([a],[b])=>a.localeCompare(b));
 if(entries.length<1||entries.length>20000)throw Error('INVALID_PUBLIC_MANIFEST');
 for(const [path,digest] of entries){
  if(path.length>240||!path.split('/').every(part=>/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part))||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)
   ||(path!=='_headers'&&!types[extname(path)]))throw Error('INVALID_PUBLIC_MANIFEST');
 }
 if(!entries.some(([path])=>path!=='_headers'))throw Error('NO_PUBLIC_ASSETS');
}
export function publicAssetManifestHash(manifest:PublicAssetManifest):string{
 validatePublicAssetManifest(manifest);
 return createHash('sha256').update(JSON.stringify({source:manifest.source,files:Object.fromEntries(Object.entries(manifest.files).sort(([a],[b])=>a<b?-1:a>b?1:0)),retainedSources:[...new Set(manifest.retainedSources??[])].sort()})).digest('hex');
}
/** Structural completeness of a retained report, not authentication of its origin. */
export function validatePublicAssetReport(origin:string,manifest:PublicAssetManifest,report:Awaited<ReturnType<typeof verifyPublicAssets>>):void{
 validatePublicAssetManifest(manifest);
 const expected=Object.entries(manifest.files).filter(([path])=>path!=='_headers');
 if(!report||report.origin!==origin||report.source!==manifest.source||report.healthy!==true||!Number.isFinite(Date.parse(report.at))||!Array.isArray(report.checks)||report.checks.length!==expected.length)throw Error('PUBLIC_ASSET_PROOF_INVALID');
 const seen=new Set<string>();
 for(const check of report.checks){
  if(!check||typeof check.path!=='string'||check.path==='_headers'||seen.has(check.path)||!Object.hasOwn(manifest.files,check.path)||check.ok!==true||check.code!=='ok'||check.status!==200||check.sha256!==manifest.files[check.path]
   ||!types[extname(check.path)]?.includes(check.contentType??'')||check.urlPath!==(['index.html','app-shell.html'].includes(check.path)?'/app-shell':'/'+check.path))throw Error('PUBLIC_ASSET_PROOF_INVALID');
  seen.add(check.path);
 }
}
export async function verifyPublicAssets(origin:string,manifest:PublicAssetManifest,options:{fetch?:typeof fetch;signal?:AbortSignal}={}){
 if(!['https://staging.porchday.com','https://porchday.org'].includes(origin))throw Error('INVALID_RELEASE_ORIGIN');
 validatePublicAssetManifest(manifest);
 const entries=Object.entries(manifest.files).sort(([a],[b])=>a.localeCompare(b)),selected=entries.filter(([path])=>path!=='_headers');
 const at=new Date().toISOString(),transport=options.fetch??fetch;
 const checks:{path:string;urlPath:string;ok:boolean;code:string;status?:number;contentType?:string;sha256?:string}[]=new Array(selected.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,selected.length)},async()=>{
  while(cursor<selected.length){
   const index=cursor++,[path,expected]=selected[index],urlPath=['index.html','app-shell.html'].includes(path)?'/app-shell':'/'+path;
   const result:typeof checks[number]={path,urlPath,ok:false,code:'transport'};let response:Response|undefined;
   try{
    const deadline=AbortSignal.timeout(10000),signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;signal.throwIfAborted();
    response=await transport(origin+urlPath,{signal,redirect:'error',headers:{'Cache-Control':'no-cache'}});result.status=response.status;
    result.contentType=(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase();
    if(response.status!==200)result.code='status';
    else if(!types[extname(path)].includes(result.contentType))result.code='content_type';
    else if(!response.body)result.code='missing_body';
    else{
     const digest=createHash('sha256'),reader=response.body.getReader();let size=0;
     try{
      while(true){const chunk=await reader.read();signal.throwIfAborted();if(chunk.done)break;size+=chunk.value.byteLength;if(size>25*1024*1024){result.code='body_limit';break;}digest.update(chunk.value);}
     }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
     if(result.code!=='body_limit'){result.sha256=digest.digest('hex');result.ok=result.sha256===expected;result.code=result.ok?'ok':'hash';}
    }
   }catch{result.code=options.signal?.aborted?'aborted':'transport';}
   finally{if(response?.body&&!response.body.locked)await response.body.cancel().catch(()=>{});checks[index]=result;}
  }
 }));
 return{at,source:manifest.source,origin,healthy:checks.every(check=>check.ok),checks,skipped:entries.filter(([path])=>path==='_headers').map(([path])=>path)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [origin,manifestPath,...extra]=process.argv.slice(2);if(!origin||!manifestPath||extra.length)throw Error('PUBLIC_ASSET_ARGUMENTS');
  const result=await verifyPublicAssets(origin,JSON.parse(readFileSync(manifestPath,'utf8')));console.log(JSON.stringify(result));if(!result.healthy)process.exitCode=1;
 }catch{console.error('PUBLIC_ASSET_VERIFICATION_FAILED');process.exitCode=1;}
}
