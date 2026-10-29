import {uploadTarget} from './release-upload-target.ts';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {FileUploadLease,type UploadPlan} from './release-upload-lease.ts';
import {createUploadReconciler,uploadReconciliationEvidenceHash,type UploadReconciliationEvidence} from './release-upload-reconcile.ts';
import {verifyUploadPreparation,readUploadConfig,assertPreparationBundle,type UploadPreparation} from './release-upload-preparation.ts';
import {createWranglerUploadProcess} from './release-upload-process.ts';
import {verifyReleaseCi} from './release-ci.ts';
import {captureReleaseSchema,assertReleaseSchema} from './release-schema.ts';
import {verifyWorkerSourceProvenance} from './release-worker-artifacts.ts';
import type {CloudflareReleaseReader} from './cloudflare-release-reader.ts';

export type PreparedUploadEvidence=UploadReconciliationEvidence&{preparation:UploadPreparation};
type Options={workspace:string;proofDirectory:string;evidence:PreparedUploadEvidence;lease:FileUploadLease;reader:Pick<CloudflareReleaseReader,'snapshot'|'uploadedVersion'|'script'>;database:{connection:string;branchId:string};accountId:string;apiToken:string;privateLogDirectory:string};
/** Build all three callbacks from one immutable, plan-bound preparation object. */
export function createPreparedUpload(options:Options){
 const database={...options.database},evidence=structuredClone(options.evidence),digest=uploadReconciliationEvidenceHash(evidence),{lease,workspace,reader}=options;
 if(!evidence.preparation)throw Error('UPLOAD_PREPARATION_REQUIRED');
 assertPreparationBundle(evidence.preparation,evidence.artifacts);
 const config=readUploadConfig(evidence.preparation);
 if(config.name!==evidence.worker||config.account_id!==options.accountId||database.branchId!==evidence.databaseBranchId)throw Error('UPLOAD_PREPARATION_TARGET_CHANGED');
 const assert=(plan:Readonly<UploadPlan>,signal:AbortSignal)=>{
  lease.assertPlan(plan,signal);
  if(plan.evidenceDigest!==digest||plan.worker!==evidence.worker||plan.source!==evidence.source)throw Error('UPLOAD_EVIDENCE_PLAN_CHANGED');
 };
 const authorize=async(plan:Readonly<UploadPlan>,signal:AbortSignal)=>{
  assert(plan,signal);await verifyUploadPreparation(workspace,evidence.preparation,signal);assert(plan,signal);
  await verifyReleaseCi({workspace,source:evidence.source,pins:evidence.ci,signal});assert(plan,signal);
  const schema=await captureReleaseSchema({...database,expectedMigrations:evidence.schema.migrations,signal});assertReleaseSchema(schema,evidence.schema);assert(plan,signal);
  await verifyWorkerSourceProvenance({workspace,source:evidence.source,application:uploadTarget(evidence.worker).application,map:readFileSync(join(evidence.artifacts.directory,evidence.artifacts.entry+'.map')),expectedPaths:evidence.artifacts.sourcePaths,signal});assert(plan,signal);
  if(!isDeepStrictEqual(await reader.snapshot(signal),evidence.before))throw Error('UPLOAD_BASELINE_CHANGED');assert(plan,signal);
 };
 const send=createWranglerUploadProcess({workspace,inputs:evidence.preparation.inputs,receipt:evidence.preparation.wrangler,configPath:evidence.preparation.configPath,configSha256:evidence.preparation.configSha256,worker:evidence.worker,accountId:options.accountId,apiToken:options.apiToken,privateLogDirectory:options.privateLogDirectory});
 const reconcile=createUploadReconciler({...options,database,evidence});
 return{authorize,send,reconcile};
}
/** One dispatch at most; every outcome still requires read-only reconciliation. Does not activate. */
export async function runPreparedUpload(options:Options,signal:AbortSignal){
 const callbacks=createPreparedUpload(options);
 const dispatch=await options.lease.dispatchOnce(callbacks.authorize,callbacks.send,signal);
 await options.lease.reconcile(callbacks.reconcile,signal);
 return{dispatch,verified:options.lease.release()};
}
