import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyReleaseUploadInputs,type ReleaseUploadInputs} from './release-upload-inputs.ts';
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-inputs-'))),bundle=join(root,'bundle'),assets=join(root,'assets');
 mkdirSync(bundle,{mode:0o700});mkdirSync(assets,{mode:0o700});
 const files=(directory:string,names:string[])=>Object.fromEntries(names.map(name=>{writeFileSync(join(directory,name),name,{mode:0o600});return[name,createHash('sha256').update(name).digest('hex')];}));
 const inputs:ReleaseUploadInputs={bundle:{directory:bundle,entry:'edge.js',files:files(bundle,['edge.js','edge.js.map'])},assets:{directory:assets,files:files(assets,['index.html','old-client.js'])}};
 const config={main:join(bundle,'edge.js'),upload_source_maps:true,find_additional_modules:false,assets:{directory:assets}};
 return{root,bundle,assets,inputs,config,close:()=>rmSync(root,{recursive:true,force:true})};
}
describe('prepared upload byte closure',()=>{
 it('verifies exact executable, map and retained asset inventory',()=>{const f=fixture();try{expect(verifyReleaseUploadInputs(f.config,f.inputs)).toEqual({bundle:{files:2,totalBytes:18},assets:{files:2,totalBytes:23}});}finally{f.close();}});
 it.each(['edge.js','edge.js.map','old-client.js'])('rejects changed prepared bytes: %s',name=>{const f=fixture();try{writeFileSync(join(name==='old-client.js'?f.assets:f.bundle,name),'changed');expect(()=>verifyReleaseUploadInputs(f.config,f.inputs)).toThrow('UPLOAD_INPUTS_CHANGED');}finally{f.close();}});
 it('rejects an extra file Wrangler would otherwise upload and a missing retained asset',()=>{const f=fixture();try{writeFileSync(join(f.assets,'unexpected.html'),'extra',{mode:0o600});expect(()=>verifyReleaseUploadInputs(f.config,f.inputs)).toThrow('UPLOAD_INPUTS_UNEXPECTED_FILE');rmSync(join(f.assets,'unexpected.html'));rmSync(join(f.assets,'old-client.js'));expect(()=>verifyReleaseUploadInputs(f.config,f.inputs)).toThrow('UPLOAD_INPUTS_MISSING_FILE');}finally{f.close();}});
 it('rejects symlink substitutions and a redirected config',()=>{const f=fixture();try{expect(()=>verifyReleaseUploadInputs({...f.config,assets:{directory:f.bundle}},f.inputs)).toThrow('UPLOAD_INPUTS_CONFIG_CHANGED');rmSync(join(f.assets,'old-client.js'));symlinkSync(join(f.bundle,'edge.js'),join(f.assets,'old-client.js'));expect(()=>verifyReleaseUploadInputs(f.config,f.inputs)).toThrow('UPLOAD_INPUTS_PERMISSIONS');}finally{f.close();}});
 it('rejects unpinned module discovery and additional module inputs',()=>{const f=fixture();try{for(const patch of [{find_additional_modules:true},{upload_source_maps:false},{rules:[]},{additional_modules:[]}])expect(()=>verifyReleaseUploadInputs({...f.config,...patch},f.inputs)).toThrow('UPLOAD_INPUTS_CONFIG_CHANGED');}finally{f.close();}});
});
