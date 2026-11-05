import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyReleaseWrangler,type ReleaseWranglerReceipt} from './release-wrangler.ts';
import {verifyReleaseUploadInputs,type ReleaseUploadInputs} from './release-upload-inputs.ts';
import {deploymentTarget} from './deployment-recovery.ts';

const guard=fileURLToPath(new URL('./release-process-guard.mjs',import.meta.url));
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function privatePath(path:string,isDirectory=false){const s=lstatSync(path);if(!isAbsolute(path)||s.isSymbolicLink()||(isDirectory?!s.isDirectory():!s.isFile())||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||!isDirectory&&s.size>2*1024*1024)throw Error('UPLOAD_PROCESS_PERMISSIONS');}
/** Low-level subprocess runner. It does not grant release authorization or perform retries. */
export async function runReleaseProcess(options:{args:string[];cwd:string;env:NodeJS.ProcessEnv;signal:AbortSignal;timeoutMs?:number}):Promise<{versionHint:string|null}>{
 options.signal.throwIfAborted();const timeout=options.timeoutMs??240000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>240000)throw Error('UPLOAD_PROCESS_TIMEOUT_INVALID');
 if(sha(readFileSync(guard))!==GUARD_SHA256)throw Error('UPLOAD_PROCESS_GUARD_CHANGED');
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--import',guard,...options.args],{cwd:options.cwd,env:options.env,stdio:['ignore','pipe','pipe','pipe','ipc'],shell:false});
  let reason:string|undefined,bytes=0,output='',killTimer:ReturnType<typeof setTimeout>|undefined;
  const stop=(code:string)=>{if(reason)return;reason=code;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);};
  const abort=()=>stop('UPLOAD_PROCESS_CANCELLED');options.signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>stop('UPLOAD_PROCESS_TIMEOUT'),timeout);
  const consume=(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>1024*1024){stop('UPLOAD_PROCESS_OUTPUT_LIMIT');return;}output+=chunk.toString('utf8');};
  child.stdout!.on('data',consume);child.stderr!.on('data',consume);
  child.on('error',()=>{reason??='UPLOAD_PROCESS_START_FAILED';});
  child.once('close',(code,exitSignal)=>{
   clearTimeout(timer);if(killTimer)clearTimeout(killTimer);options.signal.removeEventListener('abort',abort);
   if(reason||code!==0||exitSignal){reject(Error(reason??'UPLOAD_PROCESS_OUTCOME_UNKNOWN'));return;}
   const ids=[...output.matchAll(/Worker Version ID:\s*([a-f0-9-]{36})/g)].map(match=>match[1]);
   resolve({versionHint:ids.length===1&&uuid.test(ids[0])?ids[0]:null});
  });
  if(options.signal.aborted)abort();
 });
}

export type WranglerUploadProcessOptions={workspace:string;inputs:ReleaseUploadInputs;receipt:ReleaseWranglerReceipt;configPath:string;configSha256:string;worker:string;accountId:string;apiToken:string;privateLogDirectory:string};
/** Supply this callback only to FileUploadLease.dispatchOnce after full authorization. */
export function createWranglerUploadProcess(options:WranglerUploadProcessOptions):(operationId:string,signal:AbortSignal)=>Promise<void>{
 const pinned=structuredClone(options);deploymentTarget(pinned.worker);
 if(!/^[a-f0-9]{32}$/.test(pinned.accountId)||!pinned.apiToken||!/^[a-f0-9]{64}$/.test(pinned.configSha256))throw Error('UPLOAD_PROCESS_CONFIGURATION_INVALID');
 return async(operationId,signal)=>{
  signal.throwIfAborted();if(!uuid.test(operationId))throw Error('UPLOAD_PROCESS_OPERATION_INVALID');
  privatePath(pinned.configPath);privatePath(dirname(pinned.configPath),true);privatePath(pinned.privateLogDirectory,true);
  const bytes=readFileSync(pinned.configPath);if(sha(bytes)!==pinned.configSha256)throw Error('UPLOAD_PROCESS_CONFIG_CHANGED');
  let config:Record<string,unknown>;try{config=JSON.parse(bytes.toString());}catch{throw Error('UPLOAD_PROCESS_CONFIG_INVALID');}
  if(!config||typeof config!=='object'||Array.isArray(config)||config.name!==pinned.worker||config.account_id!==pinned.accountId||config.no_bundle!==true||config.build!==undefined||config.env!==undefined||config.containers!==undefined||config.exports!==undefined||config.workers_dev!==false||config.preview_urls!==false)throw Error('UPLOAD_PROCESS_CONFIG_UNREVIEWED');
  verifyReleaseUploadInputs(config,pinned.inputs);
  const cli=verifyReleaseWrangler(pinned.workspace,pinned.receipt);
  const env:NodeJS.ProcessEnv={CI:'true',NO_COLOR:'1',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_LOG_PATH:pinned.privateLogDirectory,CLOUDFLARE_API_TOKEN:pinned.apiToken,CLOUDFLARE_ACCOUNT_ID:pinned.accountId};
  for(const key of ['PATH','HOME','TMPDIR'])if(process.env[key])env[key]=process.env[key];
  await runReleaseProcess({args:[cli,'versions','upload','--config',pinned.configPath,'--message','porchday-upload:'+operationId],cwd:pinned.workspace,env,signal});
 };
}

const GUARD_SHA256='8bd7a47f14ea20b29cfcfc91e4b2d1f92cba3e810c4ea83c4590c6289f8c9f3e';
