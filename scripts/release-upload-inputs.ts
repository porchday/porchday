import {createHash} from 'node:crypto';
import {constants,closeSync,lstatSync,openSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';

export type ReleaseUploadInputs={
 bundle:{directory:string;entry:'index.js'|'edge.js';files:Record<string,string>};
 assets:{directory:string;files:Record<string,string>}|null;
};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** Verify the entire directory, including unexpected files that Wrangler could upload. */
function inventory(directory:string,files:Record<string,string>){
 if(!isAbsolute(directory)||realpathSync(directory)!==directory||!files||Array.isArray(files)||!Object.keys(files).length||Object.keys(files).length>20000)throw Error('UPLOAD_INPUTS_INVALID');
 const expected=new Set(Object.keys(files));let total=0,count=0;
 for(const [name,digest] of Object.entries(files))if(name.length>240||!name.split('/').every(part=>/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part)&&part!=='.'&&part!=='..')||!/^[a-f0-9]{64}$/.test(digest))throw Error('UPLOAD_INPUTS_INVALID');
 const walk=(path:string,prefix:string,depth:number)=>{
  const stat=lstatSync(path);
  if(depth>20||!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw Error('UPLOAD_INPUTS_PERMISSIONS');
  for(const entry of readdirSync(path,{withFileTypes:true})){
   if(++count>40000)throw Error('UPLOAD_INPUTS_LIMIT');
   const name=prefix+entry.name,child=join(path,entry.name);
   if(entry.isDirectory()){walk(child,name+'/',depth+1);continue;}
   const s=lstatSync(child);
   if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('UPLOAD_INPUTS_PERMISSIONS');
   if(!expected.delete(name))throw Error('UPLOAD_INPUTS_UNEXPECTED_FILE');
   total+=s.size;if(s.size>25*1024*1024||total>100*1024*1024)throw Error('UPLOAD_INPUTS_LIMIT');
   const fd=openSync(child,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const bytes=readFileSync(fd);if(bytes.length!==s.size||sha(bytes)!==files[name])throw Error('UPLOAD_INPUTS_CHANGED');}finally{closeSync(fd);}
  }
 };
 walk(directory,'',0);if(expected.size)throw Error('UPLOAD_INPUTS_MISSING_FILE');
 return{files:Object.keys(files).length,totalBytes:total};
}
/** Local byte closure only; source/CI authorization and hosted verification remain required. */
export function verifyReleaseUploadInputs(config:Record<string,unknown>,inputs:ReleaseUploadInputs){
 if(!inputs||!inputs.bundle||!['index.js','edge.js'].includes(inputs.bundle.entry))throw Error('UPLOAD_INPUTS_INVALID');
 const bundle=inputs.bundle;
 if(Object.keys(bundle.files).sort().join(',')!==[bundle.entry,bundle.entry+'.map'].sort().join(',')||config.main!==join(bundle.directory,bundle.entry)||config.upload_source_maps!==true||config.find_additional_modules!==false)throw Error('UPLOAD_INPUTS_CONFIG_CHANGED');
 for(const field of ['rules','additional_modules','wasm_modules','text_blobs','data_blobs'])if(config[field]!==undefined)throw Error('UPLOAD_INPUTS_CONFIG_CHANGED');
 const executable=inventory(bundle.directory,bundle.files);
 let assets=null;
 if(inputs.assets){
  if(!config.assets||typeof config.assets!=='object'||Array.isArray(config.assets)||(config.assets as {directory?:unknown}).directory!==inputs.assets.directory)throw Error('UPLOAD_INPUTS_CONFIG_CHANGED');
  assets=inventory(inputs.assets.directory,inputs.assets.files);
 }else if(config.assets!==undefined)throw Error('UPLOAD_INPUTS_CONFIG_CHANGED');
 return{bundle:executable,assets};
}
