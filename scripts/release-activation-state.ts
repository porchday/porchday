import {isDeepStrictEqual} from 'node:util';
import {deploymentPlanHash,recoveryTarget,type DeploymentPlan,type DeploymentPorts,type RecoveryJournal} from './deployment-recovery.ts';
import {leasedDeploymentPorts,type FileDeploymentLease} from './deployment-recovery-lease.ts';
import type {CloudflareReleaseReader} from './cloudflare-release-reader.ts';
import type {UploadManifest} from './release-upload-cli.ts';
import {readCompletedUpload,assertActivationInventory} from './release-activation-evidence.ts';
import {verifyUploadTooling} from './release-upload-preparation.ts';
import {verifyReleaseCi,type ReleaseCiPin} from './release-ci.ts';
import {captureReleaseSchema,assertReleaseSchema} from './release-schema.ts';

type CiPins=Record<'verify'|'history',ReleaseCiPin>;
export type ActivationStateEvidence={version:1;uploadPlanHash:string;uploadProofSha256:string;tooling:{source:string;ci:CiPins};baseline:{source:string;ci:CiPins}};
type Checks={tooling:typeof verifyUploadTooling;ci:typeof verifyReleaseCi;schema:typeof captureReleaseSchema};
/** Fresh read-only state gate, not compatibility authorization or a deployment transport.
 * The enclosing activation evidence must bind `evidence` into plan.evidenceDigest.
 * CI checks honor the caller's deadline; a timeout never grants authorization.
 */
type StateOptions={routingProgress?:()=>Promise<number>;workspace:string;plan:DeploymentPlan;manifest:UploadManifest;proofPath:string;evidence:ActivationStateEvidence;lease:Pick<FileDeploymentLease,'assert'>;reader:Pick<CloudflareReleaseReader,'snapshot'>;database:{connection:string;branchId:string};checks?:Checks};
export function createActivationStateVerifier(options:StateOptions){
 const plan=structuredClone(options.plan),planHash=deploymentPlanHash(plan),manifest=structuredClone(options.manifest),evidence=structuredClone(options.evidence),database={...options.database};
 const {workspace,proofPath,lease,reader}=options,checks=options.checks??{tooling:verifyUploadTooling,ci:verifyReleaseCi,schema:captureReleaseSchema};
 const upload=readCompletedUpload(manifest,proofPath),target=recoveryTarget(plan.worker);
 if(evidence.version!==1||evidence.uploadPlanHash!==upload.uploadPlanHash||evidence.uploadProofSha256!==upload.proofSha256||database.branchId!==manifest.evidence.databaseBranchId||! /^[a-f0-9]{40}$/.test(evidence.baseline.source))throw Error('ACTIVATION_STATE_EVIDENCE_CHANGED');
 // Validate the complete plan/upload relationship before any external reads.
 assertActivationInventory(upload,plan,plan.baselineVersion,upload.inventory);
 const assert=(input:DeploymentPlan,signal:AbortSignal)=>{
  signal.throwIfAborted();if(deploymentPlanHash(input)!==planHash)throw Error('ACTIVATION_STATE_PLAN_CHANGED');
  const canonical=lease.assert(plan,signal),edge=canonical.edgeRouting as Record<string,unknown>|undefined;
  const baselineSource=target.monitor?(canonical.monitorSources as Record<string,unknown>|undefined)?.[target.environment]:target.frontend?edge?.[target.environment+'FrontendSource']:canonical[target.environment+'RuntimeSource'];
  if(baselineSource!==evidence.baseline.source)throw Error('ACTIVATION_BASELINE_SOURCE_CHANGED');
  const current=readCompletedUpload(manifest,proofPath);
  if(!isDeepStrictEqual(current,upload))throw Error('ACTIVATION_UPLOAD_EVIDENCE_CHANGED');
 };
 const schema=async(signal:AbortSignal)=>{
  const actual=await checks.schema({...database,expectedMigrations:[...manifest.evidence.schema.migrations],signal});
  assertReleaseSchema(actual,manifest.evidence.schema);assert(plan,signal);return actual;
 };
 const inventory=async(version:string,signal:AbortSignal,transition=false)=>{
  const observed=await reader.snapshot(signal);assert(plan,signal);assertActivationInventory(upload,plan,version,observed,transition&&plan.routing&&options.routingProgress?await options.routingProgress():undefined);return observed;
 };
 /** Use before activation (baseline active) or before rollback (candidate active).
  * Fresh CI is required for both retained runtime sources and the current tooling.
  * Upload-time tooling may differ; its archived proof is checked independently.
  */
 const authorizeState=async(input:DeploymentPlan,direction:'activate'|'rollback',signal:AbortSignal)=>{
  if(!['activate','rollback'].includes(direction))throw Error('ACTIVATION_DIRECTION_INVALID');
  assert(input,signal);await checks.tooling(workspace,evidence.tooling.source,signal);assert(input,signal);
  // Settle all independent reads before returning, including when one gate fails.
  const results=await Promise.allSettled([
   checks.ci({workspace,source:evidence.tooling.source,pins:structuredClone(evidence.tooling.ci),signal}),
   checks.ci({workspace,source:manifest.evidence.source,pins:structuredClone(manifest.evidence.ci),signal}),
   checks.ci({workspace,source:evidence.baseline.source,pins:structuredClone(evidence.baseline.ci),signal}),
   schema(signal),inventory(direction==='activate'?plan.baselineVersion:plan.candidateVersion,signal,direction==='rollback'),
  ]);
  for(const result of results)if(result.status==='rejected')throw result.reason;
  assert(input,signal);await checks.tooling(workspace,evidence.tooling.source,signal);assert(input,signal);
  // Recheck resources/schema after CI: don't authorize using an earlier snapshot.
  const final=await Promise.allSettled([schema(signal),inventory(direction==='activate'?plan.baselineVersion:plan.candidateVersion,signal,direction==='rollback')]);
  for(const result of final)if(result.status==='rejected')throw result.reason;
  assert(input,signal);
 };
 /** Bracket journey verification/finalization with this check. No login or mutation. */
 const verifyState=async(version:string,signal:AbortSignal)=>{
  assert(plan,signal);
  if(![plan.baselineVersion,plan.candidateVersion].includes(version))throw Error('ACTIVATION_STATE_VERSION_CHANGED');
  const results=await Promise.allSettled([schema(signal),inventory(version,signal)]);
  for(const result of results)if(result.status==='rejected')throw result.reason;
  assert(plan,signal);
  return{schema:(results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof schema>>>).value,inventory:(results[1] as PromiseFulfilledResult<unknown>).value};
 };
 return{authorizeState,verifyState};
}

/** Compose with the existing controller. The required caller authorizer checks
 * reviewed compatibility and binds all activation evidence to plan.evidenceDigest.
 * State gates and the real lease cannot be bypassed by the supplied transport.
 * Finalization remains separate and requires a terminal journal plus fresh proofs.
 */
export function createPreparedActivationPorts(options:StateOptions&{lease:FileDeploymentLease;journal:RecoveryJournal;ports:DeploymentPorts}):DeploymentPorts{
 const gate=createActivationStateVerifier(options),ports={...options.ports};
 return leasedDeploymentPorts(options.plan,options.lease,options.journal,{
  async authorize(plan,direction,signal){
   await ports.authorize(plan,direction,signal);
   await gate.authorizeState(plan,direction,signal);
  },
  observe:signal=>ports.observe(signal),
  deploy:(version,operationId,signal)=>ports.deploy(version,operationId,signal),
  async verify(version,signal){
   await gate.verifyState(version,signal);
   const result=await ports.verify(version,signal);
   await gate.verifyState(version,signal);
   return result;
  },
 });
}
