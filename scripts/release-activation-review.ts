import {constants,closeSync,fstatSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {deploymentPlanHash,deploymentTarget,type DeploymentPlan,type DeploymentPorts} from './deployment-recovery.ts';
import {createPreparedActivationPorts,type ActivationStateEvidence} from './release-activation-state.ts';
import type {UploadManifest} from './release-upload-cli.ts';
import {readCompletedUpload} from './release-activation-evidence.ts';
import {assertReleaseSchema,type ReleaseSchemaFingerprint} from './release-schema.ts';
import {publicAssetManifestHash,type PublicAssetManifest} from './release-assets-verify.ts';
export const compatibilityChecks=['schemaRollback','denialReaders','webClientOverlap','nativeClientOverlap','retainedAssets','stagingAcceptance'] as const;
type EvidenceFile={path:string;sha256:string};
export type CompatibilityReview={version:1;worker:string;candidate:{version:string;source:string};baseline:{version:string;source:string};schema:ReleaseSchemaFingerprint;publicAssets:{candidate:string;baseline:string};checks:Record<typeof compatibilityChecks[number],{status:'passed'|'scheduled';basis:string;evidence:EvidenceFile[]}>};
export type ActivationExecution={root:string;workspace:string;uploadManifest:EvidenceFile;proofPath:string;probe:EvidenceFile;journalDirectory:string;proofDirectory:string;journeyDirectory:string};
export type ActivationReviewEvidence={execution?:ActivationExecution;version:1;state:ActivationStateEvidence;compatibility:EvidenceFile;assets:{candidate:PublicAssetManifest;baseline:PublicAssetManifest}};
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
function canonical(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
 throw Error('ACTIVATION_REVIEW_INVALID');
}
function keys(value:unknown,expected:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||!isDeepStrictEqual(Object.keys(value).sort(),[...expected].sort()))throw Error('ACTIVATION_REVIEW_INVALID');}
export function activationReviewHash(evidence:ActivationReviewEvidence){return hash(canonical(evidence));}
function readEvidence(file:EvidenceFile){
 keys(file,['path','sha256']);
 if(typeof file.path!=='string'||!isAbsolute(file.path)||realpathSync(file.path)!==file.path||! /^[a-f0-9]{64}$/.test(file.sha256))throw Error('ACTIVATION_REVIEW_FILE_INVALID');
 const fd=openSync(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=fstatSync(fd);if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size<1||stat.size>16*1024*1024)throw Error('ACTIVATION_REVIEW_FILE_INVALID');
  const bytes=readFileSync(fd);if(bytes.length!==stat.size||hash(bytes)!==file.sha256)throw Error('ACTIVATION_REVIEW_FILE_CHANGED');return bytes;
 }finally{closeSync(fd);}
}
/** Pins the operator's reviewed compatibility assessment and its underlying evidence.
 * This checks scope, completeness and immutable bytes, not the truth of arbitrary
 * test output or the reviewer's semantic conclusions. No approval is inferred from CI.
 */
export function verifyActivationReview(plan:DeploymentPlan,manifest:UploadManifest,proofPath:string,input:ActivationReviewEvidence){
 const evidence=structuredClone(input);deploymentPlanHash(plan);
 if(plan.evidenceDigest!==activationReviewHash(evidence))throw Error('ACTIVATION_REVIEW_PLAN_CHANGED');
 keys(evidence,['version','state','compatibility','assets',...(evidence.execution===undefined?[]:['execution'])]);keys(evidence.assets,['candidate','baseline']);
 if(evidence.version!==1)throw Error('ACTIVATION_REVIEW_INVALID');
 const upload=readCompletedUpload(manifest,proofPath);
 if(evidence.state.version!==1||evidence.state.uploadPlanHash!==upload.uploadPlanHash||evidence.state.uploadProofSha256!==upload.proofSha256||upload.worker!==plan.worker||upload.source!==plan.candidateSource||upload.candidateVersion!==plan.candidateVersion||upload.baselineVersion!==plan.baselineVersion)throw Error('ACTIVATION_REVIEW_UPLOAD_CHANGED');
 const publicAssets={candidate:publicAssetManifestHash(evidence.assets.candidate),baseline:publicAssetManifestHash(evidence.assets.baseline)};
 if(plan.assetManifests&&!isDeepStrictEqual(plan.assetManifests,publicAssets))throw Error('ACTIVATION_REVIEW_ASSETS_CHANGED');
 const review=JSON.parse(readEvidence(evidence.compatibility).toString()) as CompatibilityReview;
 keys(review,['version','worker','candidate','baseline','schema','publicAssets','checks']);
 if(review.version!==1||review.worker!==plan.worker||!isDeepStrictEqual(review.candidate,{version:plan.candidateVersion,source:plan.candidateSource})||!isDeepStrictEqual(review.baseline,{version:plan.baselineVersion,source:evidence.state.baseline.source})||!isDeepStrictEqual(review.publicAssets,publicAssets))throw Error('ACTIVATION_COMPATIBILITY_SCOPE_CHANGED');
 assertReleaseSchema(review.schema,manifest.evidence.schema);keys(review.checks,[...compatibilityChecks]);
 let total=0;const verified=new Map<string,string>(),pendingChecks:string[]=[];
 for(const name of compatibilityChecks){
  const check=review.checks[name];keys(check,['status','basis','evidence']);
  if(typeof check.basis!=='string'||check.basis.trim().length<1||check.basis.length>4096||!Array.isArray(check.evidence)||check.evidence.length>20)throw Error('ACTIVATION_COMPATIBILITY_INCOMPLETE');
  // A staging candidate must be activated before its hosted acceptance can run.
  // This exception is explicit, limited to that gate, and forbidden in production.
  if(name==='stagingAcceptance'&&check.status==='scheduled'&&deploymentTarget(plan.worker).environment==='staging'&&check.evidence.length===0){pendingChecks.push(name);continue;}
  if(check.status!=='passed'||check.evidence.length<1)throw Error('ACTIVATION_COMPATIBILITY_INCOMPLETE');
  for(const file of check.evidence){
   keys(file,['path','sha256']);
   if(verified.has(file.path)){if(verified.get(file.path)!==file.sha256)throw Error('ACTIVATION_REVIEW_FILE_CHANGED');continue;}
   const bytes=readEvidence(file);total+=bytes.length;if(total>64*1024*1024)throw Error('ACTIVATION_REVIEW_TOO_LARGE');verified.set(file.path,file.sha256);
  }
 }
 return{evidenceDigest:plan.evidenceDigest,reviewSha256:evidence.compatibility.sha256,files:verified.size,checks:[...compatibilityChecks],pendingChecks};
}

/** Concrete reviewed authorizer: callers supply observations, one-shot transport
 * and journeys, but cannot substitute an empty compatibility callback.
 */
export function createReviewedActivationPorts(options:Omit<Parameters<typeof createPreparedActivationPorts>[0],'evidence'|'ports'>&{review:ActivationReviewEvidence;ports:Omit<DeploymentPorts,'authorize'>}):DeploymentPorts{
 const plan=structuredClone(options.plan),manifest=structuredClone(options.manifest),review=structuredClone(options.review),proofPath=options.proofPath,ports={...options.ports};
 const check=(input:DeploymentPlan,signal:AbortSignal)=>{signal.throwIfAborted();if(deploymentPlanHash(input)!==deploymentPlanHash(plan))throw Error('ACTIVATION_REVIEW_PLAN_CHANGED');verifyActivationReview(input,manifest,proofPath,review);signal.throwIfAborted();};
 check(plan,new AbortController().signal);
 return createPreparedActivationPorts({...options,plan,manifest,evidence:review.state,ports:{
  ...ports,
  authorize:async(input,_direction,signal)=>{check(input,signal);},
  verify:async(version,signal)=>{check(plan,signal);const result=await ports.verify(version,signal);check(plan,signal);return result;},
 }});
}
