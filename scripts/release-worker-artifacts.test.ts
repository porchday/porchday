import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {verifyWorkerArtifacts,verifyWorkerSourceProvenance} from './release-worker-artifacts.ts';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value));
function fixture(){
 const map={version:3,sources:['src/index.ts',...['agent-base/src/helpers.ts','agent-base/src/index.ts','https-proxy-agent/src/parse-proxy-response.ts','https-proxy-agent/src/index.ts'].map(path=>'../node_modules/'+path)],sourceRoot:'/reviewed/build',sourcesContent:['reviewed source',null,null,null,null],names:['symbol'],mappings:'AAAA'};
 const expected={'index.js':Buffer.from('reviewed executable'),'index.js.map':encode(map)},hashes=Object.fromEntries(Object.entries(expected).map(([key,value])=>[key,createHash('sha256').update(value).digest('hex')]));
 const {sourceRoot:_,...rest}=map,normalized={...rest,file:'',sourcesRoot:null,sourcesContent:map.sourcesContent.map(value=>value??'')};
 return{entry:'index.js' as const,expected,hashes,actual:{...expected},map,normalized};
}
describe('uploaded Worker artifact verification',()=>{
 it('compares the exact reviewed first-party set to committed Git blobs despite worktree edits',async()=>{
  const workspace=mkdtempSync(join(tmpdir(),'porchday-provenance-')),expectedPaths=['apps/api/src/index.ts','packages/crypto/src/shared.ts'];
  const run=(args:string[])=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try{
   run(['init','-q']);run(['config','user.name','Synthetic Test']);run(['config','user.email','synthetic@example.invalid']);
   for(const path of expectedPaths){mkdirSync(dirname(join(workspace,path)),{recursive:true});writeFileSync(join(workspace,path),'reviewed '+path);}
   run(['add','.']);run(['commit','-qm','fixture']);const source=run(['rev-parse','HEAD']);
   const map={version:3,sources:expectedPaths.map(path=>'../../'+path),sourcesContent:expectedPaths.map(path=>'reviewed '+path),names:[],mappings:'AAAA'};
   writeFileSync(join(workspace,expectedPaths[0]),'uncommitted change');
   const options={workspace,source,application:'api' as const,expectedPaths,map:encode(map),signal:AbortSignal.timeout(5000)};
   expect(Object.keys((await verifyWorkerSourceProvenance(options)).files)).toEqual(expectedPaths);
   await expect(verifyWorkerSourceProvenance({...options,map:encode({...map,sourcesContent:['wrong',map.sourcesContent[1]]})})).rejects.toThrow('SOURCE_CONTENT_CHANGED');
   await expect(verifyWorkerSourceProvenance({...options,expectedPaths:[expectedPaths[0]]})).rejects.toThrow('SOURCE_SET_CHANGED');
   await expect(verifyWorkerSourceProvenance({...options,map:encode({...map,sources:[map.sources[0],map.sources[0]]})})).rejects.toThrow('SOURCE_PATH_INVALID');
   await expect(verifyWorkerSourceProvenance({...options,source:'f'.repeat(40)})).rejects.toThrow(/^RELEASE_WORKER_GIT_READ_FAILED$/);
  }finally{rmSync(workspace,{recursive:true,force:true});}
 });
 it('rejects unsafe provenance paths, mutable refs and cancelled reads',async()=>{
  const f=fixture(),base={workspace:process.cwd(),source:'a'.repeat(40),application:'api' as const,map:encode(f.map),expectedPaths:['apps/api/src/index.ts'],signal:AbortSignal.timeout(5000)};
  for(const patch of [{source:'main'},{expectedPaths:['apps/api/src/../../private.ts']},{expectedPaths:[]},{expectedPaths:['apps/api/src/index.ts','apps/api/src/index.ts']}])await expect(verifyWorkerSourceProvenance({...base,...patch})).rejects.toThrow('PROVENANCE_INPUT_INVALID');
  const abort=new AbortController();abort.abort();await expect(verifyWorkerSourceProvenance({...base,signal:abort.signal})).rejects.toThrow();
 });
 it('requires exact executable and preparation hashes',()=>{
  const f=fixture();expect(verifyWorkerArtifacts(f).mapMode).toBe('byte-identical');
  expect(()=>verifyWorkerArtifacts({...f,actual:{...f.actual,'index.js':Buffer.from('other executable')}})).toThrow('EXECUTABLE_CHANGED');
  expect(()=>verifyWorkerArtifacts({...f,hashes:{...f.hashes,'index.js':'0'.repeat(64)}})).toThrow('PREPARATION_CHANGED');
 });
 it('accepts only explicitly allowed observed normalization, preserving every substantive map field',()=>{
  const f=fixture(),actual={...f.actual,'index.js.map':encode(f.normalized)};
  expect(()=>verifyWorkerArtifacts({...f,actual})).toThrow('MAP_CHANGED');
  expect(verifyWorkerArtifacts({...f,actual,allowObservedMapNormalization:true}).mapMode).toBe('observed-provider-normalization');
  for(const patch of [{mappings:'changed'},{names:['changed']},{sourcesContent:['changed','','','','']},{sources:['different',...f.normalized.sources.slice(1)]},{extra:'unreviewed'}])expect(()=>verifyWorkerArtifacts({...f,allowObservedMapNormalization:true,actual:{...actual,'index.js.map':encode({...f.normalized,...patch})}})).toThrow('MAP_CHANGED');
 });
 it('accepts observed path normalization for complete monitor maps without weakening content checks',()=>{
  const f=fixture(),map={version:3,sources:['../../apps/monitor/src/index.ts'],sourceRoot:'/reviewed/build',sourcesContent:['complete monitor source'],names:['symbol'],mappings:'AAAA'};
  const {sourceRoot:_,...rest}=map,normalized={...rest,file:'index.js',sourcesRoot:null,sources:['apps/monitor/src/index.ts']};
  const expected={...f.expected,'index.js.map':encode(map)},hashes={...f.hashes,'index.js.map':createHash('sha256').update(expected['index.js.map']).digest('hex')};
  const options={...f,expected,hashes,actual:{...f.actual,'index.js.map':encode(normalized)},allowObservedMapNormalization:true,allowObservedPathNormalization:true};
  expect(verifyWorkerArtifacts(options).mapMode).toBe('observed-provider-path-normalization');
  expect(()=>verifyWorkerArtifacts({...options,allowObservedPathNormalization:false})).toThrow('MAP_CHANGED');
  for(const patch of [{sourcesContent:['altered']},{sources:['other.ts']},{mappings:'BBBB'},{names:['different']},{file:'other.js'},{extra:1}])expect(()=>verifyWorkerArtifacts({...options,actual:{...options.actual,'index.js.map':encode({...normalized,...patch})}})).toThrow('MAP_CHANGED');
  const incomplete=encode({...map,sourcesContent:[null]});
  expect(()=>verifyWorkerArtifacts({...options,expected:{...expected,'index.js.map':incomplete},hashes:{...hashes,'index.js.map':createHash('sha256').update(incomplete).digest('hex')},actual:{...options.actual,'index.js.map':encode({...normalized,sourcesContent:['']})}})).toThrow('MAP_CHANGED');
 });
 it('rejects unexpected modules and malformed maps even when their local hashes match',()=>{
  const f=fixture();expect(()=>verifyWorkerArtifacts({...f,actual:{...f.actual,'extra.js':Buffer.from('extra')}})).toThrow('MODULE_SET_CHANGED');
  const bytes=Buffer.from('{}'),hash=createHash('sha256').update(bytes).digest('hex');
  expect(()=>verifyWorkerArtifacts({...f,expected:{...f.expected,'index.js.map':bytes},actual:{...f.actual,'index.js.map':bytes},hashes:{...f.hashes,'index.js.map':hash}})).toThrow('MAP_INVALID');
 });
 it('requires separate opt-in for exact leading-parent removal and entry filename normalization',()=>{
  const f=fixture(),normalized={...f.normalized,file:f.entry,sources:f.map.sources.map(path=>path.replace(/^(?:\.\.\/)+/,''))},actual={...f.actual,'index.js.map':encode(normalized)};
  expect(()=>verifyWorkerArtifacts({...f,actual,allowObservedMapNormalization:true})).toThrow('MAP_CHANGED');
  expect(verifyWorkerArtifacts({...f,actual,allowObservedMapNormalization:true,allowObservedPathNormalization:true}).mapMode).toBe('observed-provider-path-normalization');
  for(const patch of [{file:'other.js'},{sources:normalized.sources.map((path,index)=>index===0?'other.ts':path)},{mappings:'BBBB'}])expect(()=>verifyWorkerArtifacts({...f,actual:{...actual,'index.js.map':encode({...normalized,...patch})},allowObservedMapNormalization:true,allowObservedPathNormalization:true})).toThrow('MAP_CHANGED');
 });
});
