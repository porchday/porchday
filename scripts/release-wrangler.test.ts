import {afterEach,describe,expect,it} from 'vitest';
import {chmodSync,copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {patchReleaseWrangler,prepareReleaseWrangler,verifyReleaseWrangler} from './release-wrangler.ts';
const roots:string[]=[];
const original=readFileSync('node_modules/wrangler/wrangler-dist/cli.js');
function workspace(){
 const root=mkdtempSync(join(tmpdir(),'porchday-wrangler-'));roots.push(root);mkdirSync(join(root,'node_modules/wrangler/wrangler-dist'),{recursive:true});
 for(const file of ['package-lock.json','node_modules/wrangler/package.json','node_modules/wrangler/wrangler-dist/cli.js'])copyFileSync(resolve(file),join(root,file));
 return root;
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('reviewed single-attempt Wrangler version upload',()=>{
 it('prepares the real pinned CLI, checks its syntax and verifies an unchanged receipt',()=>{
  const root=workspace(),receipt=prepareReleaseWrangler(root);
  execFileSync(process.execPath,['--check',receipt.path]);expect(verifyReleaseWrangler(root,receipt)).toBe(receipt.path);expect(prepareReleaseWrangler(root)).toEqual(receipt);
  expect(readFileSync(join(root,'node_modules/wrangler/wrangler-dist/cli.js')).equals(original)).toBe(true);
 });
 it('invokes the patched version creation once on both success and uncertain errors',async()=>{
  const source=patchReleaseWrangler(original).toString();
  const snippet=source.match(/const result = await \(async \(\) => fetchResult\([\s\S]*?bindings_inherit: "strict"[\s\S]*?\)\)\(\);/)?.[0];expect(snippet).toBeTruthy();
  const run=new Function('fetchResult','config2','workerUrl','workerBundle','props',`return (async()=>{${snippet};return result;})();`);
  for(const failure of [null,new TypeError('connection reset'),new Error('500 ambiguous'),new DOMException('deadline','TimeoutError')]){
   let calls=0;
   const body={synthetic:'bundle'},config={synthetic:'config'};
   const fetchResult=async(c:unknown,url:string,request:RequestInit,query:URLSearchParams)=>{
    calls++;expect(c).toBe(config);expect(url).toBe('/workers/scripts/synthetic/versions');expect(request.method).toBe('POST');expect(request.body).toBe(body);expect(query.toString()).toBe('bindings_inherit=strict');
    if(failure)throw failure;return{id:'synthetic-version'};
   };
   const result=run(fetchResult,config,'/workers/scripts/synthetic',body,{sendMetrics:false});
   if(failure)await expect(result).rejects.toBe(failure);else expect(await result).toEqual({id:'synthetic-version'});
   expect(calls).toBe(1);
  }
 });
 it('rejects changed CLI bytes and mismatched lock or installed package before preparing',()=>{
  expect(()=>patchReleaseWrangler(Buffer.concat([original,Buffer.from('\n')]))).toThrow('RELEASE_WRANGLER_UNREVIEWED');
  for(const file of ['package-lock.json','node_modules/wrangler/package.json']){
   const root=workspace(),path=join(root,file),value=JSON.parse(readFileSync(path,'utf8'));
   if(file==='package-lock.json')value.packages['node_modules/wrangler'].integrity='changed';else value.version='0.0.0';
   writeFileSync(path,JSON.stringify(value));expect(()=>prepareReleaseWrangler(root)).toThrow('RELEASE_WRANGLER_PACKAGE_CHANGED');
  }
 });
 it('refuses tampered, broadly readable or substituted prepared files and changed receipts',()=>{
  const root=workspace(),receipt=prepareReleaseWrangler(root);
  expect(()=>verifyReleaseWrangler(root,{...receipt,lockSha256:'0'.repeat(64)})).toThrow('RELEASE_WRANGLER_RECEIPT_CHANGED');
  chmodSync(receipt.path,0o644);expect(()=>verifyReleaseWrangler(root,receipt)).toThrow('RELEASE_WRANGLER_PATCH_CHANGED');chmodSync(receipt.path,0o600);
  writeFileSync(receipt.path,'modified');expect(()=>prepareReleaseWrangler(root)).toThrow('RELEASE_WRANGLER_PATCH_CHANGED');
  rmSync(receipt.path);symlinkSync(join(root,'node_modules/wrangler/wrangler-dist/cli.js'),receipt.path);expect(()=>prepareReleaseWrangler(root)).toThrow();
 });
});
