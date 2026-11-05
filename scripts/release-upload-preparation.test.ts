import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {verifyUploadTooling,verifyUploadPreparation,assertPreparationBundle,type UploadPreparation} from './release-upload-preparation.ts';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'porchday-preparation-'))),workspace=join(root,'repo'),bundle=join(root,'bundle');mkdirSync(workspace);mkdirSync(bundle,{mode:0o700});
 const git=(args:string[])=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init','-q']);git(['config','user.name','Synthetic Test']);git(['config','user.email','synthetic@example.invalid']);writeFileSync(join(workspace,'tool.ts'),'reviewed');git(['add','.']);git(['commit','-qm','fixture']);const source=git(['rev-parse','HEAD']);
 const files=Object.fromEntries(['index.js','index.js.map'].map(name=>{writeFileSync(join(bundle,name),name,{mode:0o600});return[name,hash(name)];}));
 const configPath=join(root,'config.json'),config=JSON.stringify({main:join(bundle,'index.js'),upload_source_maps:true,find_additional_modules:false});writeFileSync(configPath,config,{mode:0o600});
 const preparation:UploadPreparation={configPath,configSha256:hash(config),inputs:{bundle:{directory:bundle,entry:'index.js',files},assets:null},wrangler:{} as UploadPreparation['wrangler'],toolingSource:source,toolingCi:{verify:{runId:1,attempt:1,workflowSha256:'a'.repeat(64)},history:{runId:2,attempt:1,workflowSha256:'b'.repeat(64)}},assetSources:[]};
 const checks={ci:vi.fn(async()=>({source,repository:'porchday/porchday',runs:[]})),tooling:verifyUploadTooling,wrangler:vi.fn(()=>'/synthetic-cli')};
 return{root,workspace,source,preparation,checks,git,close:()=>rmSync(root,{recursive:true,force:true})};
}
describe('plan-bound upload preparation',()=>{
 it('checks the committed tooling, CI and complete prepared bytes',async()=>{const f=fixture();try{const result=await verifyUploadPreparation(f.workspace,f.preparation,AbortSignal.timeout(5000),f.checks);expect(result.inputs.bundle.files).toBe(2);expect(f.checks.ci).toHaveBeenCalledOnce();expect(f.checks.wrangler).toHaveBeenCalledOnce();}finally{f.close();}});
 it.each(['tracked','untracked','assume-unchanged','wrong-head'])('rejects tooling drift: %s',async kind=>{const f=fixture();try{if(kind==='tracked')writeFileSync(join(f.workspace,'tool.ts'),'changed');if(kind==='untracked')writeFileSync(join(f.workspace,'extra.ts'),'changed');if(kind==='assume-unchanged'){f.git(['update-index','--assume-unchanged','tool.ts']);writeFileSync(join(f.workspace,'tool.ts'),'changed');}await expect(verifyUploadTooling(f.workspace,kind==='wrong-head'?'f'.repeat(40):f.source,AbortSignal.timeout(5000))).rejects.toThrow(/UPLOAD_TOOLING/);}finally{f.close();}});
 it('stops on failed CI before validating the CLI or accepting preparation',async()=>{const f=fixture();try{f.checks.ci.mockRejectedValue(Error('CI failed'));await expect(verifyUploadPreparation(f.workspace,f.preparation,AbortSignal.timeout(5000),f.checks)).rejects.toThrow('CI failed');expect(f.checks.wrangler).not.toHaveBeenCalled();}finally{f.close();}});
 it('requires asset source CI when assets are supplied and rejects a different reconciliation bundle',async()=>{const f=fixture();try{f.preparation.inputs.assets={directory:'/unused',files:{}};await expect(verifyUploadPreparation(f.workspace,f.preparation,AbortSignal.timeout(5000),f.checks)).rejects.toThrow('SOURCES_INVALID');expect(()=>assertPreparationBundle(f.preparation,{directory:'/other',entry:'index.js',hashes:f.preparation.inputs.bundle.files})).toThrow('BUNDLE_CHANGED');expect(f.checks.ci).not.toHaveBeenCalled();}finally{f.close();}});
 it('rejects config changes after CI instead of accepting a previously checked path',async()=>{const f=fixture();try{f.checks.ci.mockImplementation(async()=>{writeFileSync(f.preparation.configPath,readFileSync(f.preparation.configPath,'utf8')+' ');return{source:f.source,repository:'porchday/porchday',runs:[]};});await expect(verifyUploadPreparation(f.workspace,f.preparation,AbortSignal.timeout(5000),f.checks)).rejects.toThrow('CONFIG_CHANGED');}finally{f.close();}});
});
