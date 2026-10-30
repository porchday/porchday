import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {extname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json','.woff2':'font/woff2','.map':'application/json'};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/** Local real-browser rehearsal: delayed old-document assets, or an already-open
 * tab loading its cold lazy module after a switch alongside a fresh new tab. */
export async function verifyAssetTransition(baselineDirectory:string,targetDirectory:string,mode:'delayed-assets'|'open-tab'='delayed-assets'){
 if(!['delayed-assets','open-tab'].includes(mode))throw Error('BROWSER_MODE_INVALID');
 const baseline=realpathSync(resolve(baselineDirectory)),target=realpathSync(resolve(targetDirectory));
 const oldHtml=readFileSync(join(baseline,'app-shell.html')),newHtml=readFileSync(join(target,'app-shell.html'));
 const requests:{path:string;contentType:string;sha256:string;matchesBaseline:boolean|null;afterSwitch:boolean}[]=[];
 let switched=mode==='delayed-assets';
 const server=createServer((request,response)=>{
  try{
   if(request.method!=='GET'){response.writeHead(405).end();return;}
   const path=decodeURIComponent(new URL(request.url??'/', 'http://localhost').pathname);
   if(!/^\/[A-Za-z0-9_./-]*$/.test(path)||path.split('/').includes('..')){response.writeHead(400).end();return;}
   let contents:Buffer,contentType:string;
   if(path==='/login'){contents=mode==='open-tab'&&switched?newHtml:oldHtml;contentType='text/html';}
   else if(path==='/sw.js'){response.writeHead(404).end();return;} // No cached files can hide this transition.
   else if(path.startsWith('/api/')){response.writeHead(401,{'Content-Type':'application/json'}).end('{"error":"UNAUTHORIZED"}');return;}
   else{
    try{
     const serving=switched?target:baseline,file=realpathSync(join(serving,path.slice(1)));
     if(!file.startsWith(serving+sep)||!statSync(file).isFile())throw Error('INVALID_PUBLIC_FILE');
     contents=readFileSync(file);contentType=mime[extname(path)]??'application/octet-stream';
    }catch{contents=newHtml;contentType='text/html';} // Match the observed SPA fallback.
   }
   let matchesBaseline:boolean|null=null;
   if(path.startsWith('/assets/')){
    try{const file=realpathSync(join(baseline,path.slice(1)));if(!file.startsWith(baseline+sep))throw Error('INVALID_BASELINE_FILE');matchesBaseline=hash(contents)===hash(readFileSync(file));}catch{matchesBaseline=false;}
   }
   requests.push({path,contentType,sha256:hash(contents),matchesBaseline,afterSwitch:switched});
   response.writeHead(200,{'Content-Type':contentType,'Cache-Control':'no-store'}).end(contents);
  }catch{response.writeHead(500).end();}
 });
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
 const address=server.address();if(!address||typeof address==='string')throw Error('LOCAL_SERVER_FAILED');
 let browser;
 try{
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({serviceWorkers:'block'}),origin=`http://127.0.0.1:${address.port}`;
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();let moduleMimeErrors=0,pageErrors=0;
  page.on('pageerror',()=>{pageErrors++;});
  page.on('console',message=>{if(message.type()==='error'&&/MIME type|module script/i.test(message.text()))moduleMimeErrors++;});
  await page.goto(origin+'/login',{waitUntil:'load',timeout:15000});
  let rendered=false;try{await page.locator('input[type="password"]').waitFor({state:'visible',timeout:5000});rendered=await page.locator('input[type="email"]').isVisible();}catch{/* Retain the negative control. */}
  let openTab:undefined|{initialRendered:boolean;lazyModules:string[];loadedModules:number;oldDocumentRetained:boolean;newTabRendered:boolean;newPageErrors:number;newModuleMimeErrors:number};
  if(mode==='open-tab'){
   if(!rendered)throw Error('BROWSER_BASELINE_NOT_RENDERED');
   // Discover actual lazy imports from the old entry, not retained historical chunks.
   const entries=[...oldHtml.toString().matchAll(/src="(\/assets\/[A-Za-z0-9_-]+\.js)"/g)].map(m=>m[1]);
   if(entries.length!==1)throw Error('BROWSER_ENTRY_AMBIGUOUS');
   const entry=readFileSync(join(baseline,entries[0]),'utf8');
   const lazyModules=[...new Set([...entry.matchAll(/import\("(\.\/[A-Za-z0-9_-]+\.js)"\)/g)].map(m=>'/assets/'+m[1].slice(2)))];
   if(!lazyModules.length||lazyModules.some(path=>requests.some(r=>r.path===path)))throw Error('BROWSER_LAZY_MODULE_NOT_COLD');
   await page.getByLabel('Email address',{exact:true}).fill('retained-tab@example.test');
   switched=true;
   let loadedModules=0;
   for(const path of lazyModules){
    const loaded=await page.evaluate(async path=>{try{const module=await import(path);return typeof module.default==='function';}catch{return false;}},path);
    if(loaded)loadedModules++;
   }
   const oldDocumentRetained=await page.getByLabel('Email address',{exact:true}).inputValue()==='retained-tab@example.test'&&await page.locator('input[type="password"]').isVisible();
   // A separate context has no old modules or HTTP cache to mask the new entry.
   const fresh=await browser.newContext({serviceWorkers:'block'});
   await fresh.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   const newPage=await fresh.newPage();let newTabRendered=false,newPageErrors=0,newModuleMimeErrors=0;
   // A rendered form does not prove that the fresh client initialized safely.
   // Observe it independently: old-tab listeners cannot see new-context errors.
   newPage.on('pageerror',()=>{newPageErrors++;});
   newPage.on('console',message=>{if(message.type()==='error'&&/MIME type|module script/i.test(message.text()))newModuleMimeErrors++;});
   await newPage.goto(origin+'/login',{waitUntil:'load',timeout:15000});
   try{await newPage.locator('input[type="password"]').waitFor({state:'visible',timeout:5000});newTabRendered=await newPage.locator('input[type="email"]').isVisible();}catch{/* Retain failed acceptance. */}
   await fresh.close();
   openTab={initialRendered:rendered,lazyModules,loadedModules,oldDocumentRetained,newTabRendered,newPageErrors,newModuleMimeErrors};
  }
  const assets=requests.filter(request=>request.matchesBaseline!==null&&(mode==='delayed-assets'||request.afterSwitch&&openTab!.lazyModules.includes(request.path)));

  return{rendered,moduleMimeErrors,pageErrors,oldDocumentSha256:hash(oldHtml),assets,...(openTab?{openTab}:{}),
   assetCoverage:mode==='open-tab'?'cold lazy entrypoint bytes after switch':'requested baseline assets',
   allRequestedBaselineAssetsMatch:assets.length>0&&assets.every(asset=>asset.matchesBaseline),serviceWorkers:'blocked',api:'local unauthenticated stub',providerWrites:0};
 }finally{
  if(browser)await browser.close();
  await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [baseline,candidate,retained,flag,...extra]=process.argv.slice(2);if(!baseline||!candidate||!retained||extra.length||flag!==undefined&&flag!=='--open-tab')throw Error('BROWSER_ARGUMENTS');
  const mode=flag==='--open-tab'?'open-tab':'delayed-assets';
  const withoutRetention=await verifyAssetTransition(baseline,candidate,mode),withRetention=await verifyAssetTransition(baseline,retained,mode);
  const openHealthy=(r:typeof withRetention)=>!!r.openTab&&r.openTab.initialRendered&&r.openTab.oldDocumentRetained&&r.openTab.newTabRendered&&r.openTab.newPageErrors===0&&r.openTab.newModuleMimeErrors===0;
  const passed=(mode==='open-tab'?openHealthy(withoutRetention)&&withoutRetention.openTab!.loadedModules===0&&!withoutRetention.allRequestedBaselineAssetsMatch&&withoutRetention.moduleMimeErrors>0&&openHealthy(withRetention)&&withRetention.openTab!.loadedModules===withRetention.openTab!.lazyModules.length:!withoutRetention.rendered&&withoutRetention.moduleMimeErrors>0&&!withoutRetention.allRequestedBaselineAssetsMatch)
   &&withRetention.rendered&&withRetention.moduleMimeErrors===0&&withRetention.pageErrors===0&&withRetention.allRequestedBaselineAssetsMatch;
  console.log(JSON.stringify({passed,withoutRetention,withRetention}));if(!passed)process.exitCode=1;
 }catch{console.error('RELEASE_BROWSER_VERIFICATION_FAILED');process.exitCode=1;}
}
