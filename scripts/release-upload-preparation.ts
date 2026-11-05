import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {verifyReleaseCi,type ReleaseCiPin} from './release-ci.ts';
import {verifyReleaseWrangler,type ReleaseWranglerReceipt} from './release-wrangler.ts';
import {verifyReleaseUploadInputs,type ReleaseUploadInputs} from './release-upload-inputs.ts';

export type UploadPreparation={
 configPath:string;configSha256:string;wrangler:ReleaseWranglerReceipt;inputs:ReleaseUploadInputs;
 toolingSource:string;toolingCi:Record<'verify'|'history',ReleaseCiPin>;
 assetSources:{source:string;ci:Record<'verify'|'history',ReleaseCiPin>}[];
};
function git(workspace:string,args:string[],signal:AbortSignal):Promise<string>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>execFile('git',args,{cwd:workspace,encoding:'utf8',timeout:5000,maxBuffer:2*1024*1024,signal},(error,stdout)=>error?reject(Error('UPLOAD_TOOLING_READ_FAILED')):resolve(stdout)));
}
export async function verifyUploadTooling(workspace:string,source:string,signal:AbortSignal){
 if(!isAbsolute(workspace)||!/^[a-f0-9]{40}$/.test(source))throw Error('UPLOAD_TOOLING_INVALID');
 if((await git(workspace,['rev-parse','HEAD'],signal)).trim()!==source||await git(workspace,['status','--porcelain','--untracked-files=normal'],signal)!=='')throw Error('UPLOAD_TOOLING_CHANGED');
 // Check tracked bytes against the commit too, including skip-worktree/assume-unchanged flags.
 const flagged=await git(workspace,['ls-files','-v'],signal);
 if(flagged.split('\n').filter(Boolean).some(line=>!line.startsWith('H ')))throw Error('UPLOAD_TOOLING_INDEX_FLAGS');
 await git(workspace,['diff','--exit-code',source,'--'],signal);
 signal.throwIfAborted();return{source};
}
export function readUploadConfig(preparation:UploadPreparation){
 const path=preparation.configPath,s=lstatSync(path);
 if(!isAbsolute(path)||!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>2*1024*1024)throw Error('UPLOAD_PREPARATION_CONFIG_INVALID');
 const bytes=readFileSync(path);
 if(createHash('sha256').update(bytes).digest('hex')!==preparation.configSha256)throw Error('UPLOAD_PREPARATION_CONFIG_CHANGED');
 const config=JSON.parse(bytes.toString());if(!config||typeof config!=='object'||Array.isArray(config))throw Error('UPLOAD_PREPARATION_CONFIG_INVALID');return config as Record<string,unknown>;
}
export function assertPreparationBundle(preparation:UploadPreparation,artifacts:{directory:string;entry:string;hashes:Record<string,string>}){
 if(!isDeepStrictEqual(preparation.inputs.bundle,{directory:artifacts.directory,entry:artifacts.entry,files:artifacts.hashes}))throw Error('UPLOAD_PREPARATION_BUNDLE_CHANGED');
}
/** Reviewed preparation is included in the lease evidence digest. These reads grant no write. */
export async function verifyUploadPreparation(workspace:string,preparation:UploadPreparation,signal:AbortSignal,checks={ci:verifyReleaseCi,tooling:verifyUploadTooling,wrangler:verifyReleaseWrangler}){
 const p=structuredClone(preparation);
 if(!Array.isArray(p.assetSources)||p.assetSources.length>101||new Set(p.assetSources.map(item=>item.source)).size!==p.assetSources.length||Boolean(p.inputs.assets)!==Boolean(p.assetSources.length))throw Error('UPLOAD_PREPARATION_SOURCES_INVALID');
 await checks.tooling(workspace,p.toolingSource,signal);
 const toolingCi=await checks.ci({workspace,source:p.toolingSource,pins:p.toolingCi,signal});
 const assetCi=[];for(const item of p.assetSources)assetCi.push(await checks.ci({workspace,source:item.source,pins:item.ci,signal}));
 signal.throwIfAborted();checks.wrangler(workspace,p.wrangler);
 const inputs=verifyReleaseUploadInputs(readUploadConfig(p),p.inputs);
 await checks.tooling(workspace,p.toolingSource,signal);
 return{toolingCi,assetCi,inputs};
}
