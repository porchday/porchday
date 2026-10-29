import {createHash,randomUUID} from 'node:crypto';
import {constants,closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

export interface AssetBuild {directory:string;source:string;files:Record<string,string>}
export interface AssetPlan {candidate:AssetBuild;retained:AssetBuild[]}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const immutable=(name:string)=>name.startsWith('assets/')||/^icon-\d+-[a-f0-9]{16}\.png$/.test(name);
function validName(name:string):boolean {
 return name.length<=240&&name.split('/').every(part=>/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part)&&part!=='.'&&part!=='..');
}
function validateBuild(build:AssetBuild):void {
 if(!build||typeof build.directory!=='string'||!build.directory||typeof build.source!=='string'||!/^[a-f0-9]{40}$/.test(build.source)
  ||!build.files||Array.isArray(build.files)||typeof build.files!=='object'||!Object.keys(build.files).length)throw Error('INVALID_ASSET_BUILD');
 for(const [name,digest] of Object.entries(build.files))if(!validName(name)||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw Error('INVALID_ASSET_MANIFEST');
}
function readAsset(directory:string,name:string):Buffer {
 const root=resolve(directory),path=join(root,name);
 if(realpathSync(root)!==root||!lstatSync(root).isDirectory())throw Error('ASSET_DIRECTORY_SYMLINK');
 let parent=root;
 for(const component of name.split('/').slice(0,-1)){
  parent=join(parent,component);const stat=lstatSync(parent);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('ASSET_PARENT_SYMLINK');
 }
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>25*1024*1024)throw Error('INVALID_ASSET_FILE');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const bytes=readFileSync(fd);if(bytes.length>25*1024*1024)throw Error('INVALID_ASSET_FILE');return bytes;}finally{closeSync(fd);}
}

/** Package reviewed public builds only. Hashes prove bytes, not source provenance. */
export function assembleReleaseAssets(plan:AssetPlan,outputDirectory:string){
 if(!plan||!Array.isArray(plan.retained)||plan.retained.length>100)throw Error('INVALID_ASSET_PLAN');
 validateBuild(plan.candidate);for(const build of plan.retained)validateBuild(build);
 const output=resolve(outputDirectory);
 if(realpathSync(dirname(output))!==dirname(output))throw Error('ASSET_OUTPUT_PARENT_SYMLINK');
 for(const build of [plan.candidate,...plan.retained]){
  const input=resolve(build.directory);
  if(output===input||output.startsWith(input+sep))throw Error('ASSET_OUTPUT_OVERLAPS_INPUT');
 }
 // Never replace an existing artifact, even if it belongs to a failed earlier run.
 try{lstatSync(output);throw Error('ASSET_OUTPUT_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const bytes=new Map<string,Buffer>(),files:Record<string,string>=Object.create(null),retainedPaths=new Set<string>();let totalBytes=0;
 for(const [index,build] of [plan.candidate,...plan.retained].entries()){
  for(const [name,expected] of Object.entries(build.files).sort(([a],[b])=>a.localeCompare(b))){
   if(index>0&&!immutable(name))continue;
   const contents=readAsset(build.directory,name);
   if(hash(contents)!==expected)throw Error('ASSET_HASH_MISMATCH');
   if(bytes.has(name)){
    if(files[name]!==expected)throw Error('IMMUTABLE_ASSET_CONFLICT');
    continue;
   }
   totalBytes+=contents.length;
   if(bytes.size>=20000||totalBytes>100*1024*1024)throw Error('ASSET_PACKAGE_TOO_LARGE');
   bytes.set(name,contents);files[name]=expected;if(index>0)retainedPaths.add(name);
  }
 }
 const temporary=output+'.'+randomUUID()+'.tmp';mkdirSync(temporary,{mode:0o700});
 try{
  const directories=new Set<string>([temporary]);
  for(const [name,contents] of bytes){
   const path=join(temporary,name),parent=dirname(path);mkdirSync(parent,{recursive:true,mode:0o700});
   for(let dir=parent;dir.startsWith(temporary);dir=dirname(dir)){directories.add(dir);if(dir===temporary)break;}
   const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,contents);fsyncSync(fd);}finally{closeSync(fd);}
  }
  for(const directory of [...directories].sort((a,b)=>b.length-a.length)){
   const fd=openSync(directory,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}
  }
  // The caller serializes publication under the deployment lease. Recheck before
  // rename; this local packaging step never activates a provider version.
  try{lstatSync(output);throw Error('ASSET_OUTPUT_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  renameSync(temporary,output);
  const fd=openSync(dirname(output),constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}
 }catch(error){rmSync(temporary,{recursive:true,force:true});throw error;}
 return{source:plan.candidate.source,retainedSources:plan.retained.map(build=>build.source),files,retainedPaths:[...retainedPaths].sort(),totalBytes};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [planPath,output,...extra]=process.argv.slice(2);if(!planPath||!output||extra.length)throw Error('ASSET_ARGUMENTS');
  const plan=JSON.parse(readFileSync(planPath,'utf8')) as AssetPlan;
  console.log(JSON.stringify(assembleReleaseAssets(plan,output)));
 }catch{console.error('RELEASE_ASSET_ASSEMBLY_FAILED');process.exitCode=1;}
}
