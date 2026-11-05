import {runReleaseJourney} from './release-journey.ts';
import {randomUUID} from 'node:crypto';
import {constants,closeSync,fsyncSync,lstatSync,mkdirSync,openSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {deploymentPlanHash,deploymentTarget,type DeploymentPlan,type DeploymentPorts} from './deployment-recovery.ts';
import {probe,validateProbeConfig,type ProbeConfig} from './external-monitor-probe.ts';
import {verifyPublicAssets,validatePublicAssetManifest,publicAssetManifestHash,type PublicAssetManifest} from './release-assets-verify.ts';

function evidence(directory:string,value:unknown){
 const stat=lstatSync(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('RELEASE_EVIDENCE_DIRECTORY_INVALID');
 const path=join(directory,randomUUID()+'.json'),fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
 return path;
}

/** The normal rollout's journey/asset gate. Provider identity and authorization stay in the controller. */
export function createReleaseVerifier(options:{plan:DeploymentPlan;config:ProbeConfig;assets:{candidate:PublicAssetManifest;baseline:PublicAssetManifest};directory:string;fetch?:typeof fetch;journey?:{directory:string;assertLease:(signal:AbortSignal)=>void}}):DeploymentPorts['verify']&{assetProof:(version:string)=>string|undefined}{
 const plan=structuredClone(options.plan),planHash=deploymentPlanHash(plan),config=structuredClone(options.config),assets=structuredClone(options.assets);
 validateProbeConfig(config);validatePublicAssetManifest(assets.candidate);validatePublicAssetManifest(assets.baseline);
 if(plan.assetManifests&&(publicAssetManifestHash(assets.candidate)!==plan.assetManifests.candidate||publicAssetManifestHash(assets.baseline)!==plan.assetManifests.baseline))throw Error('RELEASE_ASSET_PLAN_MISMATCH');
 if(deploymentTarget(plan.worker).environment!==config.environment)throw Error('RELEASE_VERIFICATION_SCOPE_MISMATCH');
 if(!isAbsolute(options.directory))throw Error('RELEASE_EVIDENCE_PATH_INVALID');
 const directory=options.directory,transport=options.fetch??fetch,journey=options.journey?{...options.journey}:undefined;mkdirSync(directory,{recursive:true,mode:0o700});
 const origin=config.environment==='production'?'https://porchday.org':'https://staging.porchday.com';
 let active=false;const proofs=new Map<string,string>();
 const verify:DeploymentPorts['verify']=async(version,signal)=>{
  if(active)throw Error('RELEASE_VERIFICATION_ALREADY_RUNNING');
  if(![plan.candidateVersion,plan.baselineVersion].includes(version))throw Error('RELEASE_VERSION_NOT_IN_PLAN');
  active=true;proofs.delete(version);
  const attemptId=randomUUID(),record=(kind:string,detail:unknown)=>evidence(directory,{at:new Date().toISOString(),operationId:plan.operationId,planHash,version,attemptId,kind,detail});
  const finish=(outcome:'healthy'|'unhealthy'|'unknown')=>{record('outcome',{outcome});return outcome;};
  try{
   record('started',{environment:config.environment});
   if(signal.aborted)return finish('unknown');
   // One journey only. Read-only asset convergence must never repeat login/logout.
   const observation=journey?await runReleaseJourney({plan,version,config,directory:journey.directory,assertLease:journey.assertLease,fetch:transport},signal):await probe(config,{fetch:(input,init)=>transport(input,{...init,signal:AbortSignal.any([signal,init?.signal??new AbortController().signal])})});
   record('journey',observation);
   if(signal.aborted)return finish('unknown');
   // A completed probe with failed/timeout checks is an observed failed journey,
   // even when it cannot diagnose the cause. It is sufficient for a safe rollback
   // only because the controller independently reauthorizes a compatible target.
   if('status' in observation){if(observation.status==='unknown')return finish('unknown');if(observation.status==='unhealthy')return finish('unhealthy');}
   else if(!observation.healthy)return finish('unhealthy');
   const manifest=version===plan.candidateVersion?assets.candidate:assets.baseline;
   for(let round=1;round<=3;round++){
    if(signal.aborted)return finish('unknown');
    const report=await verifyPublicAssets(origin,manifest,{fetch:transport,signal});record('assets',{round,report});
    if(signal.aborted)return finish('unknown');
    if(report.healthy){
     const proof=plan.assetManifests?record('asset-proof',{manifest,report}):undefined;
     const outcome=finish('healthy');if(proof)proofs.set(version,proof);return outcome;
    }
    if(round<3)try{await sleep(round===1?250:750,undefined,{signal});}catch{return finish('unknown');}
   }
   return finish('unhealthy');
  }finally{active=false;}
 };
 return Object.assign(verify,{assetProof:(version:string)=>proofs.get(version)});
}
