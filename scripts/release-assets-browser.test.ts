import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const roots:string[]=[];
const form=`document.body.innerHTML='<label for="email">Email address</label><input id="email" type="email"><input type="password">';`;
function fixture(fault:'none'|'exception'|'mime'){
 const root=mkdtempSync(join(tmpdir(),'release-browser-'));roots.push(root);
 const baseline=join(root,'baseline'),candidate=join(root,'candidate'),retained=join(root,'retained');
 for(const dir of [baseline,candidate,retained])mkdirSync(join(dir,'assets'),{recursive:true});
 const oldEntry=form+'\nexport const load=()=>import("./Lazy-old.js");';
 const newEntry=form+(fault==='exception'?'\nthrow Error("synthetic new-client failure");':fault==='mime'?'\nawait import("./missing.js").catch(()=>{});':'');
 writeFileSync(join(baseline,'app-shell.html'),'<html><body><script type="module" src="/assets/index-old.js"></script></body></html>');
 writeFileSync(join(baseline,'assets/index-old.js'),oldEntry);
 writeFileSync(join(baseline,'assets/Lazy-old.js'),'export default function Lazy() {}');
 for(const dir of [candidate,retained]){
  writeFileSync(join(dir,'app-shell.html'),'<html><body><script type="module" src="/assets/index-new.js"></script></body></html>');
  writeFileSync(join(dir,'assets/index-new.js'),newEntry);
 }
 writeFileSync(join(retained,'assets/index-old.js'),oldEntry);
 writeFileSync(join(retained,'assets/Lazy-old.js'),'export default function Lazy() {}');
 return{baseline,candidate,retained};
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe.skipIf(process.env.RELEASE_ASSET_BROWSER_TESTS!=='1')('real Chromium open-tab release acceptance',()=>{
 for(const fault of ['none','exception','mime'] as const)it(`checks both old and fresh tabs: ${fault}`,()=>{
  const f=fixture(fault),result=spawnSync(process.execPath,[resolve('scripts/release-assets-browser.ts'),f.baseline,f.candidate,f.retained,'--open-tab'],{encoding:'utf8',timeout:25000,maxBuffer:1024*1024});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();
  const report=JSON.parse(result.stdout);expect(report.withRetention.openTab.oldDocumentRetained).toBe(true);expect(report.withRetention.openTab.newTabRendered).toBe(true);
  expect(report.withoutRetention.openTab.loadedModules).toBe(0);expect(report.withRetention.openTab.loadedModules).toBe(1);
  if(fault==='none'){expect(result.status).toBe(0);expect(report.passed).toBe(true);}
  else{expect(report.passed).toBe(false);expect(result.status).toBe(1);expect(report.withRetention.openTab[fault==='exception'?'newPageErrors':'newModuleMimeErrors']).toBeGreaterThan(0);}
 },30000);
});
