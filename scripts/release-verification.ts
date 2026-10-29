import {randomUUID} from 'node:crypto';
import {constants,closeSync,fsyncSync,lstatSync,mkdirSync,openSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {deploymentPlanHash,deploymentTarget,type DeploymentPlan,type DeploymentPorts} from './deployment-recovery.ts';
import {probe,validateProbeConfig,type ProbeConfig} from './external-monitor-probe.ts';
import {verifyPublicAssets,validatePublicAssetManifest,type PublicAssetManifest} from './release-assets-verify.ts';

function evidence(directory:string,value:unknown){
 const stat=lstatSync(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('RELEASE_EVIDENCE_DIRECTORY_INVALID');
 const fd=openSync(join(directory,randomUUID()+'.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
}

/** The normal rollout's journey/asset gate. Provider identity and authorization stay in the controller. */
export function createReleaseVerifier(options:{plan:DeploymentPlan;config:ProbeConfig;assets:{candidate:PublicAssetManifest;baseline:PublicAssetManifest};directory:string;fetch?:typeof fetch}):DeploymentPorts['verify']{
 const plan=structuredClone(options.plan),planHash=deploymentPlanHash(plan),config=structuredClone(options.config),assets=structuredClone(options.assets);
 validateProbeConfig(config);validatePublicAssetManifest(assets.candidate);validatePublicAssetManifest(assets.baseline);
 if(deploymentTarget(plan.worker).environment!==config.environment)throw Error('RELEASE_VERIFICATION_SCOPE_MISMATCH');
 if(!isAbsolute(options.directory))throw Error('RELEASE_EVIDENCE_PATH_INVALID');
 const directory=options.directory,transport=options.fetch??fetch;mkdirSync(directory,{recursive:true,mode:0o700});
 const origin=config.environment==='production'?'https://porchday.org':'https://staging.porchday.com';
 let active=false;
 return async(version,signal)=>{
  if(active)throw Error('RELEASE_VERIFICATION_ALREADY_RUNNING');
  if(![plan.candidateVersion,plan.baselineVersion].includes(version))throw Error('RELEASE_VERSION_NOT_IN_PLAN');
  active=true;
  const attemptId=randomUUID(),record=(kind:string,detail:unknown)=>evidence(directory,{at:new Date().toISOString(),operationId:plan.operationId,planHash,version,attemptId,kind,detail});
  const finish=(outcome:'healthy'|'unhealthy'|'unknown')=>{record('outcome',{outcome});return outcome;};
  try{
   record('started',{environment:config.environment});
   if(signal.aborted)return finish('unknown');
   // One journey only. Read-only asset convergence must never repeat login/logout.
   const observation=await probe(config,{fetch:(input,init)=>transport(input,{...init,signal:AbortSignal.any([signal,init?.signal??new AbortController().signal])})});
   record('journey',observation);
   if(signal.aborted)return finish('unknown');
   // A completed probe with failed/timeout checks is an observed failed journey,
   // even when it cannot diagnose the cause. It is sufficient for a safe rollback
   // only because the controller independently reauthorizes a compatible target.
   if(!observation.healthy)return finish('unhealthy');
   const manifest=version===plan.candidateVersion?assets.candidate:assets.baseline;
   for(let round=1;round<=3;round++){
    if(signal.aborted)return finish('unknown');
    const report=await verifyPublicAssets(origin,manifest,{fetch:transport,signal});record('assets',{round,report});
    if(signal.aborted)return finish('unknown');
    if(report.healthy)return finish('healthy');
    if(round<3)try{await sleep(round===1?250:750,undefined,{signal});}catch{return finish('unknown');}
   }
   return finish('unhealthy');
  }finally{active=false;}
 };
}
