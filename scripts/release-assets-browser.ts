import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {extname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json','.webmanifest':'application/manifest+json','.woff2':'font/woff2','.map':'application/json'};
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

/** An old document's assets arrive after a simulated version switch. Local only. */
export async function verifyAssetTransition(baselineDirectory:string,targetDirectory:string){
 const baseline=realpathSync(resolve(baselineDirectory)),target=realpathSync(resolve(targetDirectory));
 const oldHtml=readFileSync(join(baseline,'app-shell.html')),newHtml=readFileSync(join(target,'app-shell.html'));
 const requests:{path:string;contentType:string;sha256:string;matchesBaseline:boolean|null}[]=[];
 const server=createServer((request,response)=>{
  try{
   if(request.method!=='GET'){response.writeHead(405).end();return;}
   const path=decodeURIComponent(new URL(request.url??'/', 'http://localhost').pathname);
   if(!/^\/[A-Za-z0-9_./-]*$/.test(path)||path.split('/').includes('..')){response.writeHead(400).end();return;}
   let contents:Buffer,contentType:string;
   if(path==='/login'){contents=oldHtml;contentType='text/html';}
   else if(path==='/sw.js'){response.writeHead(404).end();return;} // No cached files can hide this transition.
   else if(path.startsWith('/api/')){response.writeHead(401,{'Content-Type':'application/json'}).end('{"error":"UNAUTHORIZED"}');return;}
   else{
    try{
     const file=realpathSync(join(target,path.slice(1)));
     if(!file.startsWith(target+sep)||!statSync(file).isFile())throw Error('INVALID_PUBLIC_FILE');
     contents=readFileSync(file);contentType=mime[extname(path)]??'application/octet-stream';
    }catch{contents=newHtml;contentType='text/html';} // Match the observed SPA fallback.
   }
   let matchesBaseline:boolean|null=null;
   if(path.startsWith('/assets/')){
    try{const file=realpathSync(join(baseline,path.slice(1)));if(!file.startsWith(baseline+sep))throw Error('INVALID_BASELINE_FILE');matchesBaseline=hash(contents)===hash(readFileSync(file));}catch{matchesBaseline=false;}
   }
   requests.push({path,contentType,sha256:hash(contents),matchesBaseline});
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
  const assets=requests.filter(request=>request.matchesBaseline!==null);
  return{rendered,moduleMimeErrors,pageErrors,oldDocumentSha256:hash(oldHtml),assets,
   allRequestedBaselineAssetsMatch:assets.length>0&&assets.every(asset=>asset.matchesBaseline),serviceWorkers:'blocked',api:'local unauthenticated stub',providerWrites:0};
 }finally{
  if(browser)await browser.close();
  await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [baseline,candidate,retained,...extra]=process.argv.slice(2);if(!baseline||!candidate||!retained||extra.length)throw Error('BROWSER_ARGUMENTS');
  const withoutRetention=await verifyAssetTransition(baseline,candidate),withRetention=await verifyAssetTransition(baseline,retained);
  const passed=!withoutRetention.rendered&&withoutRetention.moduleMimeErrors>0&&!withoutRetention.allRequestedBaselineAssetsMatch
   &&withRetention.rendered&&withRetention.moduleMimeErrors===0&&withRetention.pageErrors===0&&withRetention.allRequestedBaselineAssetsMatch;
  console.log(JSON.stringify({passed,withoutRetention,withRetention}));if(!passed)process.exitCode=1;
 }catch{console.error('RELEASE_BROWSER_VERIFICATION_FAILED');process.exitCode=1;}
}
