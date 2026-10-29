import {createContinuityGate} from './release-continuity-gate.ts';
import {verifyMonitorRead} from './release-monitor-verification.ts';
import {constants,closeSync,fsyncSync,lstatSync,openSync,realpathSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {deploymentPlanHash,recoveryTarget,rollbackOperationId,validateRecoveryState,type DeploymentPlan,type RecoveryJournal} from './deployment-recovery.ts';
import type {FileDeploymentLease} from './deployment-recovery-lease.ts';
import type {CloudflareDeploymentClient} from './cloudflare-deployment-client.ts';
import {createActivationStateVerifier} from './release-activation-state.ts';
import {verifyActivationReview,type ActivationReviewEvidence} from './release-activation-review.ts';
import {verifyPublicAssets,validatePublicAssetReport} from './release-assets-verify.ts';

function persist(directory:string,value:unknown){
 const stat=lstatSync(directory);
 if(!isAbsolute(directory)||realpathSync(directory)!==directory||!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw Error('ACTIVATION_FINAL_PROOF_DIRECTORY_INVALID');
 const bytes=JSON.stringify(value)+'\n';if(Buffer.byteLength(bytes)>32*1024*1024)throw Error('ACTIVATION_FINAL_PROOF_TOO_LARGE');
 const path=join(directory,randomUUID()+'.json'),fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
 const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}return path;
}
type Options=Omit<Parameters<typeof createActivationStateVerifier>[0],'evidence'|'lease'>&{lease:FileDeploymentLease;journal:RecoveryJournal;review:ActivationReviewEvidence;directory:string;client:Pick<CloudflareDeploymentClient,'observe'>;fetch?:typeof fetch};
/** Only GETs, schema reads and local proof/canonical writes. Never a journey or deployment.
 * The controller must already have a terminal journal. Ambiguous finalization resumes
 * the exact durable receipt; it does not recollect evidence or repeat any remote work.
 */
export async function finalizePreparedActivation(options:Options,signal:AbortSignal){
 const plan:DeploymentPlan=structuredClone(options.plan),review=structuredClone(options.review),manifest=structuredClone(options.manifest),{lease,journal,client,directory,proofPath}=options;
 const hash=deploymentPlanHash(plan);signal.throwIfAborted();
 const state=await journal.read();validateRecoveryState(state);
 if(state.planHash!==hash||!['complete','rolled-back'].includes(state.phase))throw Error('ACTIVATION_FINAL_OUTCOME_UNRESOLVED');
 if(await lease.resumeFinalization(journal)){if(state.phase==='complete')createContinuityGate(directory,plan).assertPromotion();return{status:'resumed-historical-finalization' as const};}
 lease.assert(plan,signal);
 const successful=state.phase==='complete',version=successful?plan.candidateVersion:plan.baselineVersion,expectedDeployment=successful?state.candidateDeploymentId:state.rollbackDeploymentId,expectedOperation=successful?plan.operationId:rollbackOperationId(plan.operationId);
 const continuity=createContinuityGate(directory,plan);
 const check=()=>{if(successful)continuity.assertPromotion();lease.assert(plan,signal);verifyActivationReview(plan,manifest,proofPath,review);};
 const identity=async()=>{const observed=await client.observe(signal);check();if(observed.version!==version||observed.deploymentId!==expectedDeployment||observed.operationId!==expectedOperation)throw Error('ACTIVATION_FINAL_DEPLOYMENT_CHANGED');};
 check();const gate=createActivationStateVerifier({...options,plan,manifest,evidence:review.state});
 await identity();await gate.verifyState(version,signal);
 const assets=successful?review.assets.candidate:review.assets.baseline,origin=recoveryTarget(plan.worker).environment==='production'?'https://porchday.org':'https://staging.porchday.com';
 const report=await verifyPublicAssets(origin,assets,{fetch:options.fetch,signal});
 validatePublicAssetReport(origin,assets,report);check();
 if(recoveryTarget(plan.worker).monitor)await verifyMonitorRead({plan,review,version,directory,assertScope:check,fetch:options.fetch},signal);
 const final=await gate.verifyState(version,signal);await identity();
 const current=await journal.read();if(JSON.stringify(current)!==JSON.stringify(state))throw Error('ACTIVATION_FINAL_JOURNAL_CHANGED');check();
 const snapshot=persist(directory,final.inventory),assetProof=persist(directory,{at:new Date().toISOString(),operationId:plan.operationId,planHash:hash,version,kind:'asset-proof',detail:{manifest:assets,report}});
 check();await lease.finalize(journal,snapshot,plan.assetManifests?assetProof:undefined);
 await lease.release(journal);
 return{status:'finalized' as const,outcome:state.phase,version,snapshot,assetProof};
}
