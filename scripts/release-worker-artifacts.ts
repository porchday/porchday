import {createHash} from 'node:crypto';
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const missingSources=['node_modules/agent-base/src/helpers.ts','node_modules/agent-base/src/index.ts','node_modules/https-proxy-agent/src/parse-proxy-response.ts','node_modules/https-proxy-agent/src/index.ts'];
function sourceMap(bytes:Uint8Array):Record<string,unknown>{
 let value:Record<string,unknown>;try{value=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{throw Error('RELEASE_WORKER_MAP_INVALID');}
 if(!value||value.version!==3||!Array.isArray(value.sources)||!value.sources.length||value.sources.some(x=>typeof x!=='string')||!Array.isArray(value.sourcesContent)||value.sourcesContent.length!==value.sources.length||value.sourcesContent.some(x=>x!==null&&typeof x!=='string')||!Array.isArray(value.names)||value.names.some(x=>typeof x!=='string')||typeof value.mappings!=='string')throw Error('RELEASE_WORKER_MAP_INVALID');return value;
}
function canonical(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
 throw Error('RELEASE_WORKER_MAP_INVALID');
}
/** Reviewed bytes/hashes must be pinned to source and CI by the release authorizer. */
export function verifyWorkerArtifacts(options:{entry:'index.js'|'edge.js';expected:Record<string,Uint8Array>;hashes:Record<string,string>;actual:Record<string,Uint8Array>;allowObservedMapNormalization?:boolean}){
 const {entry,expected,actual,hashes}=options;if(!['index.js','edge.js'].includes(entry))throw Error('RELEASE_WORKER_ENTRY_INVALID');
 const names=[entry,entry+'.map'].sort();
 for(const value of [expected,actual,hashes])if(Object.keys(value).sort().join(',')!==names.join(','))throw Error('RELEASE_WORKER_MODULE_SET_CHANGED');
 for(const name of names){if(!(expected[name] instanceof Uint8Array)||!(actual[name] instanceof Uint8Array)||expected[name].length>16*1024*1024||actual[name].length>16*1024*1024||!/^[a-f0-9]{64}$/.test(hashes[name])||hash(expected[name])!==hashes[name])throw Error('RELEASE_WORKER_PREPARATION_CHANGED');}
 if(!Buffer.from(expected[entry]).equals(actual[entry]))throw Error('RELEASE_WORKER_EXECUTABLE_CHANGED');
 const local=sourceMap(expected[entry+'.map']),remote=sourceMap(actual[entry+'.map']);let mapMode:'byte-identical'|'observed-provider-normalization'='byte-identical';
 if(!Buffer.from(expected[entry+'.map']).equals(actual[entry+'.map'])){
  if(!options.allowObservedMapNormalization||Object.keys(local).sort().join(',')!=='mappings,names,sourceRoot,sources,sourcesContent,version'||typeof local.sourceRoot!=='string'||!local.sourceRoot)throw Error('RELEASE_WORKER_MAP_CHANGED');
  const sources=local.sources as string[],contents=local.sourcesContent as (string|null)[],missing=sources.filter((_,index)=>contents[index]===null);
  if(missing.length!==4||missingSources.some(suffix=>missing.filter(path=>path.endsWith('/'+suffix)||path===suffix).length!==1))throw Error('RELEASE_WORKER_MAP_CHANGED');
  const normalized={...local,file:'',sourcesRoot:null,sourcesContent:contents.map(value=>value??'')};delete (normalized as Record<string,unknown>).sourceRoot;
  if(canonical(normalized)!==canonical(remote))throw Error('RELEASE_WORKER_MAP_CHANGED');mapMode='observed-provider-normalization';
 }
 return{entry,mapMode,hashes:Object.fromEntries(names.map(name=>[name,hash(actual[name])])),sourceCount:(remote.sources as string[]).length};
}
