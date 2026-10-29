import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {verifyWorkerArtifacts} from './release-worker-artifacts.ts';
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value));
function fixture(){
 const map={version:3,sources:['src/index.ts',...['agent-base/src/helpers.ts','agent-base/src/index.ts','https-proxy-agent/src/parse-proxy-response.ts','https-proxy-agent/src/index.ts'].map(path=>'../node_modules/'+path)],sourceRoot:'/reviewed/build',sourcesContent:['reviewed source',null,null,null,null],names:['symbol'],mappings:'AAAA'};
 const expected={'index.js':Buffer.from('reviewed executable'),'index.js.map':encode(map)},hashes=Object.fromEntries(Object.entries(expected).map(([key,value])=>[key,createHash('sha256').update(value).digest('hex')]));
 const {sourceRoot:_,...rest}=map,normalized={...rest,file:'',sourcesRoot:null,sourcesContent:map.sourcesContent.map(value=>value??'')};
 return{entry:'index.js' as const,expected,hashes,actual:{...expected},map,normalized};
}
describe('uploaded Worker artifact verification',()=>{
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
 it('rejects unexpected modules and malformed maps even when their local hashes match',()=>{
  const f=fixture();expect(()=>verifyWorkerArtifacts({...f,actual:{...f.actual,'extra.js':Buffer.from('extra')}})).toThrow('MODULE_SET_CHANGED');
  const bytes=Buffer.from('{}'),hash=createHash('sha256').update(bytes).digest('hex');
  expect(()=>verifyWorkerArtifacts({...f,expected:{...f.expected,'index.js.map':bytes},actual:{...f.actual,'index.js.map':bytes},hashes:{...f.hashes,'index.js.map':hash}})).toThrow('MAP_INVALID');
 });
});
