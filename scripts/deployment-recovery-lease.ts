/** POSIX/Node 24 lease shared with existing Porchday directory-lock tooling. */
import {DatabaseSync} from 'node:sqlite';
import {constants,openSync,closeSync,fsyncSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync,unlinkSync,renameSync,existsSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {deploymentPlanHash,recoveryTarget,rollbackOperationId,RecoveryError,validateRecoveryState,type DeploymentObservation,type DeploymentPlan,type RecoveryJournal,type DeploymentPorts,type RecoveryState} from './deployment-recovery.ts';
import {validateSchemaFingerprint,type ReleaseSchemaFingerprint} from './release-schema.ts';
import {publicAssetManifestHash,validatePublicAssetReport,type PublicAssetManifest} from './release-assets-verify.ts';
const protocol='porchday-deployment-recovery-sqlite-v1';
const assetProofLimit=32*1024*1024;
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function privateDirectory(path:string){const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.uid!==process.getuid?.())throw new RecoveryError('DEPLOYMENT_LEASE_PERMISSIONS');}
function privateFile(path:string,max=2*1024*1024){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.uid!==process.getuid?.()||s.size>max)throw new RecoveryError('DEPLOYMENT_LEASE_PERMISSIONS');}
function privateText(path:string,max=2*1024*1024){privateFile(path,max);return readFileSync(path,'utf8');}
function syncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
type Owner={v:1;protocol:typeof protocol;owner:string;operationId:string;planHash:string;source:string;baselineSha256:string;at:string};
function checkCanonical(plan:DeploymentPlan,text:string):Record<string,unknown>{
  let canonical:Record<string,unknown>;try{canonical=JSON.parse(text);}catch{throw new RecoveryError('DEPLOYMENT_CANONICAL_INVALID');}
  const {environment,frontend,monitor,key}=recoveryTarget(plan.worker),floor=(canonical.compatibleRollbackVersions as Record<string,unknown>|undefined)?.[monitor?key:environment],edge=canonical.edgeRouting as Record<string,unknown>|undefined;
  const version=monitor?(canonical.monitorVersions as Record<string,unknown>|undefined)?.[environment]:frontend?edge?.[environment+'FrontendVersion']:canonical[environment+'Version'],source=monitor?(canonical.monitorSources as Record<string,unknown>|undefined)?.[environment]:frontend?edge?.[environment+'FrontendSource']:canonical[environment+'RuntimeSource'];
  if(version!==plan.baselineVersion||typeof source!=='string'||! /^[a-f0-9]{40}$/.test(source))throw new RecoveryError('DEPLOYMENT_BASELINE_CHANGED');
  if(frontend&&(edge?.[environment+'Enabled']!==(plan.routing?false:true)||canonical[environment+'Version']!==plan.backendVersion||typeof canonical[environment+'RuntimeSource']!=='string'||! /^[a-f0-9]{40}$/.test(canonical[environment+'RuntimeSource'] as string)))throw new RecoveryError('DEPLOYMENT_FRONTEND_BACKEND_CHANGED');
  if(plan.assetManifests&&!frontend&&edge?.[environment+'Enabled']===true)throw new RecoveryError('DEPLOYMENT_ASSETS_NOT_PUBLIC_TARGET');
  if(plan.readerFloorPromotion&&plan.readerFloorPromotion.previousVersion!==floor)throw new RecoveryError('DEPLOYMENT_READER_FLOOR_CHANGED');
  if(typeof floor!=='string'||(frontend?plan.backendReaderFloor!==floor:!plan.compatibleRollbackVersions.includes(floor)))throw new RecoveryError('DEPLOYMENT_READER_FLOOR_NOT_ACKNOWLEDGED');
  return canonical;
}
type SnapshotReceipt={path:string;sha256:string};
type Finalization={v:1;planHash:string;terminal:RecoveryState;before:string;after:string;snapshot?:SnapshotReceipt;assets?:SnapshotReceipt;schema?:SnapshotReceipt};
function terminalState(state:unknown,hash:string):asserts state is RecoveryState{
 validateRecoveryState(state);if(state.planHash!==hash||!['complete','rolled-back'].includes(state.phase))throw new RecoveryError('DEPLOYMENT_LEASE_OUTCOME_UNRESOLVED');
}
function finalizedRecord(plan:DeploymentPlan,state:RecoveryState,before:string,snapshot?:SnapshotReceipt,assets?:SnapshotReceipt,schema?:SnapshotReceipt):string{
 const record=checkCanonical(plan,before),{environment,frontend,monitor,key}=recoveryTarget(plan.worker),success=state.phase==='complete',edge=record.edgeRouting as Record<string,unknown>|undefined;
 const version=success?plan.candidateVersion:plan.baselineVersion,source=success?plan.candidateSource:monitor?(record.monitorSources as Record<string,unknown>)[environment]:frontend?edge?.[environment+'FrontendSource']:record[environment+'RuntimeSource'];
 if(monitor&&!snapshot)throw new RecoveryError('DEPLOYMENT_MONITOR_SNAPSHOT_REQUIRED');
 let observedBindings:unknown;
 if(snapshot){
  if(!isAbsolute(snapshot.path)||!/^[a-f0-9]{64}$/.test(snapshot.sha256))throw new RecoveryError('DEPLOYMENT_SNAPSHOT_INVALID');
  const bytes=privateText(snapshot.path);if(digest(bytes)!==snapshot.sha256)throw new RecoveryError('DEPLOYMENT_SNAPSHOT_CHANGED');
  const observed=JSON.parse(bytes);observedBindings=observed?.workers?.[key]?.resources?.bindings;if(observed?.workers?.[key]?.active!==version)throw new RecoveryError('DEPLOYMENT_SNAPSHOT_VERSION_CHANGED');
  if(frontend&&observed?.workers?.[environment]?.active!==plan.backendVersion)throw new RecoveryError('DEPLOYMENT_SNAPSHOT_BACKEND_CHANGED');
 }
 if(plan.routing){
  if(!snapshot)throw new RecoveryError('DEPLOYMENT_ROUTING_SNAPSHOT_REQUIRED');
  const observed=JSON.parse(privateText(snapshot.path));
  if(!Array.isArray(observed.domains))throw new RecoveryError('DEPLOYMENT_ROUTING_PROOF_INVALID');
  for(const move of plan.routing.moves){
   const target=success?move.after:move.before,rows=observed.domains.filter((d:Record<string,unknown>)=>d.hostname===target.hostname);
   if(rows.length!==1||rows[0].service!==target.service||rows[0].zone_id!==target.zoneId||rows[0].environment!==target.environment||rows[0].enabled!==true||rows[0].previews_enabled!==false)throw new RecoveryError('DEPLOYMENT_ROUTING_PROOF_INVALID');
  }
 }
 let manifest:PublicAssetManifest|undefined,manifestHash:string|undefined;
 if(plan.assetManifests){
  if(!snapshot||!assets||!isAbsolute(assets.path)||!/^[a-f0-9]{64}$/.test(assets.sha256))throw new RecoveryError('DEPLOYMENT_ASSET_PROOF_REQUIRED');
  if(!frontend&&edge?.[environment+'Enabled']===true)throw new RecoveryError('DEPLOYMENT_ASSETS_NOT_PUBLIC_TARGET');
  const bytes=privateText(assets.path,assetProofLimit);if(digest(bytes)!==assets.sha256)throw new RecoveryError('DEPLOYMENT_ASSET_PROOF_CHANGED');
  try{
   const proof=JSON.parse(bytes);
   if(proof.operationId!==plan.operationId||proof.planHash!==deploymentPlanHash(plan)||proof.version!==version||proof.kind!=='asset-proof')throw Error('scope');
   manifest=proof.detail?.manifest;manifestHash=publicAssetManifestHash(manifest!);
   if(manifestHash!==(success?plan.assetManifests.candidate:plan.assetManifests.baseline))throw Error('manifest');
   validatePublicAssetReport(environment==='production'?'https://porchday.org':'https://staging.porchday.com',manifest!,proof.detail.report);
  }catch{throw new RecoveryError('DEPLOYMENT_ASSET_PROOF_INVALID');}
 }else if(assets)throw new RecoveryError('DEPLOYMENT_UNPLANNED_ASSET_PROOF');
 let verifiedSchema:{branchId:string;schema:ReleaseSchemaFingerprint}|undefined;
 if(schema){
  if(!isAbsolute(schema.path)||!/^[a-f0-9]{64}$/.test(schema.sha256))throw new RecoveryError('DEPLOYMENT_SCHEMA_PROOF_INVALID');
  const bytes=privateText(schema.path);if(digest(bytes)!==schema.sha256)throw new RecoveryError('DEPLOYMENT_SCHEMA_PROOF_CHANGED');
  try{
   const proof=JSON.parse(bytes);
   if(Object.keys(proof).sort().join(',')!=='branchId,kind,operationId,planHash,schema,version,worker'||proof.kind!=='schema-proof'||proof.operationId!==plan.operationId||proof.planHash!==deploymentPlanHash(plan)||proof.worker!==plan.worker||proof.version!==version||typeof proof.branchId!=='string'||!/^[a-z0-9]+$/.test(proof.branchId))throw Error('scope');
   validateSchemaFingerprint(proof.schema);verifiedSchema={branchId:proof.branchId,schema:proof.schema};
  }catch{throw new RecoveryError('DEPLOYMENT_SCHEMA_PROOF_INVALID');}
 }
 if(plan.readerFloorPromotion){
  if(!snapshot||!verifiedSchema||!verifiedSchema.schema.migrations.includes('057_privacy_transaction_commits.sql')||!Array.isArray(observedBindings)||observedBindings.some(b=>b?.name==='PRIVACY_COMMIT_WRITER_V1'))throw new RecoveryError('DEPLOYMENT_READER_FLOOR_PROOF_REQUIRED');
  const readers=observedBindings.filter(b=>b?.name==='PRIVACY_COMMIT_RECOVERY_V1');
  if(success&&(readers.length!==1||readers[0].type!=='plain_text'||readers[0].text!=='true'))throw new RecoveryError('DEPLOYMENT_READER_FLOOR_PROOF_REQUIRED');
 }
 return JSON.stringify({...record,...(success&&plan.readerFloorPromotion?{compatibleRollbackVersions:{...(record.compatibleRollbackVersions as Record<string,unknown>),[environment]:plan.candidateVersion}}:{}),...(verifiedSchema?{schemaMigrationsByEnvironment:{...(record.schemaMigrationsByEnvironment as Record<string,unknown>|undefined),[environment]:verifiedSchema.schema.migrations.length},schemaEvidenceByEnvironment:{...(record.schemaEvidenceByEnvironment as Record<string,unknown>|undefined),[environment]:{branchId:verifiedSchema.branchId,fingerprint:verifiedSchema.schema,proof:schema}}}:{}),...(snapshot?{latestProviderSnapshot:snapshot.path}:{}),...(monitor?{monitorVersions:{...(record.monitorVersions as Record<string,unknown>),[environment]:version},monitorSources:{...(record.monitorSources as Record<string,unknown>),[environment]:source}}:frontend?{edgeRouting:{...edge,...(plan.routing?{[environment+'Enabled']:success}:{}),[environment+'FrontendVersion']:version,[environment+'FrontendSource']:source,...(manifest&&!(plan.routing&&!success)?{[environment+'FrontendAssetsSource']:manifest.source}:{})}}:{[environment+'Version']:version,[environment+'RuntimeSource']:source,[environment+'Source']:source}),
 ...(manifest?{[environment+'AssetsSource']:manifest.source,releaseAssets:{...(record.releaseAssets as Record<string,unknown>|undefined),[plan.routing&&!success?environment:key]:{version:plan.routing&&!success?plan.backendVersion:version,source:manifest.source,retainedSources:manifest.retainedSources??[],manifestSha256:manifestHash,proof:assets}}}:{}),
 deploymentRecovery:{...(record.deploymentRecovery as Record<string,unknown>|undefined),[key]:{operationId:plan.operationId,planHash:deploymentPlanHash(plan),outcome:state.phase,version,source,deploymentId:success?state.candidateDeploymentId:state.rollbackDeploymentId,evidenceDigest:plan.evidenceDigest,...(snapshot?{providerSnapshotSha256:snapshot.sha256}:{})}}})+'\n';
}
function readFinalization(directory:string,plan:DeploymentPlan,owner:Owner):Finalization|null{
 const path=join(directory,'finalization.json');if(!existsSync(path))return null;
 let value:Finalization;try{value=JSON.parse(privateText(path,6*1024*1024));}catch{throw new RecoveryError('DEPLOYMENT_FINALIZATION_INVALID');}
 if(!value||value.v!==1||value.planHash!==owner.planHash||typeof value.before!=='string'||typeof value.after!=='string'||digest(value.before)!==owner.baselineSha256)throw new RecoveryError('DEPLOYMENT_FINALIZATION_INVALID');
 terminalState(value.terminal,owner.planHash);
 if(value.after!==finalizedRecord(plan,value.terminal,value.before,value.snapshot,value.assets,value.schema))throw new RecoveryError('DEPLOYMENT_FINALIZATION_INVALID');
 return value;
}
/** Local replacement only: complete bytes and directory entries are durable before returning. */
function atomicText(path:string,text:string,root:string):void{
 const temporary=join(root,'deployment-recovery-tmp-'+randomUUID());
 const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}
 try{renameSync(temporary,path);syncDirectory(root);}finally{if(existsSync(temporary))unlinkSync(temporary);}
}
function archivePath(root:string,plan:DeploymentPlan){return join(root,'deployment-recovery-completed-'+plan.operationId);}
export class FileDeploymentLease{
 private readonly root:string;
 private readonly db:DatabaseSync;
 private readonly owner:Owner;
 private readonly plan:DeploymentPlan;
 private held=true;
 private resolvingFailure=false;
 private constructor(root:string,db:DatabaseSync,owner:Owner,plan:DeploymentPlan){this.root=root;this.db=db;this.owner=owner;this.plan=Object.freeze({...plan,...(plan.routing?{routing:structuredClone(plan.routing)}:{}),...(plan.readerFloorPromotion?{readerFloorPromotion:Object.freeze({...plan.readerFloorPromotion})}:{}),...(plan.assetManifests?{assetManifests:Object.freeze({...plan.assetManifests})}:{}),compatibleRollbackVersions:Object.freeze([...plan.compatibleRollbackVersions])});}
 /** Read-only early rejection for new operations, before fixture preparation.
  * Not authorization: acquisition and dispatch repeat the canonical checks.
  */
 static preflight(root:string,plan:DeploymentPlan):void{
  if(!isAbsolute(root))throw new RecoveryError('DEPLOYMENT_LEASE_PATH_INVALID');privateDirectory(root);deploymentPlanHash(plan);
  if(existsSync(archivePath(root,plan)))throw new RecoveryError('DEPLOYMENT_ALREADY_FINALIZED');
  if(existsSync(join(root,'deployment-recovery-cancelled-'+plan.operationId)))throw new RecoveryError('DEPLOYMENT_ALREADY_CANCELLED');
  if(existsSync(join(root,'deployment-recovery-failed-'+plan.operationId)))throw new RecoveryError('DEPLOYMENT_ALREADY_RESOLVED_FAILED');
  checkCanonical(plan,privateText(join(root,'latest-verified-deployment.json')));
 }
 /** No time-based stealing. Resume only the same plan while holding the kernel lock. */
 static acquire(root:string,plan:DeploymentPlan):FileDeploymentLease{
  if(!isAbsolute(root))throw new RecoveryError('DEPLOYMENT_LEASE_PATH_INVALID');privateDirectory(root);
  const planHash=deploymentPlanHash(plan),databasePath=join(root,'deployment-recovery.lock.sqlite');
  try{const fd=openSync(databasePath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);syncDirectory(root);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  privateFile(databasePath);let db:DatabaseSync|undefined;
  try{db=new DatabaseSync(databasePath);db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}
  catch{db?.close();throw new RecoveryError('DEPLOYMENT_LEASE_BUSY');}
  try{
   const canonical=privateText(join(root,'latest-verified-deployment.json')),directory=join(root,'deployment-lock'),ownerPath=join(directory,'owner.json');let created=false;
   if(existsSync(join(root,'deployment-recovery-failed-'+plan.operationId)))throw new RecoveryError('DEPLOYMENT_ALREADY_RESOLVED_FAILED');
   if(existsSync(archivePath(root,plan)))throw new RecoveryError('DEPLOYMENT_ALREADY_FINALIZED');
   if(existsSync(join(root,'deployment-recovery-cancelled-'+plan.operationId)))throw new RecoveryError('DEPLOYMENT_ALREADY_CANCELLED');
   if(!existsSync(directory))checkCanonical(plan,canonical);
   try{mkdirSync(directory,{mode:0o700});created=true;syncDirectory(root);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   privateDirectory(directory);let owner:Owner;
   if(created){
    owner={v:1,protocol,owner:'deployment-recovery-'+plan.operationId,operationId:plan.operationId,planHash,source:plan.candidateSource,baselineSha256:digest(canonical),at:new Date().toISOString()};
    const fd=openSync(ownerPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,JSON.stringify(owner)+'\n');fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(directory);
   }else{
    try{owner=JSON.parse(privateText(ownerPath,4096));}catch{throw new RecoveryError('DEPLOYMENT_LEASE_HELD');}
    if(owner.v!==1||owner.protocol!==protocol||owner.owner!=='deployment-recovery-'+plan.operationId||owner.operationId!==plan.operationId||owner.planHash!==planHash||owner.source!==plan.candidateSource)throw new RecoveryError('DEPLOYMENT_LEASE_HELD');
   }
   const lease=new FileDeploymentLease(root,db,owner,plan),finalization=readFinalization(directory,plan,owner);
   if(finalization){lease.assertOwner();if(canonical!==finalization.before&&canonical!==finalization.after)throw new RecoveryError('DEPLOYMENT_CANONICAL_CHANGED');}
   else if(existsSync(join(directory,'failed-recovery.json'))){lease.assertOwner();if(digest(canonical)!==owner.baselineSha256)throw new RecoveryError('DEPLOYMENT_CANONICAL_CHANGED');checkCanonical(plan,canonical);}
   else lease.assert(plan);return lease;
  }catch(error){db.exec('ROLLBACK');db.close();throw error;}
 }
 private assertOwner():void{
  if(!this.held)throw new RecoveryError('DEPLOYMENT_LEASE_NOT_HELD');privateDirectory(this.root);privateDirectory(join(this.root,'deployment-lock'));
  let current:unknown;try{current=JSON.parse(privateText(join(this.root,'deployment-lock','owner.json'),4096));}catch{throw new RecoveryError('DEPLOYMENT_LEASE_CHANGED');}
  if(JSON.stringify(current)!==JSON.stringify(this.owner))throw new RecoveryError('DEPLOYMENT_LEASE_CHANGED');
 }
 /** Checks canonical identity/floor acknowledgement; artifact/schema proof is additionally required. */
 assert(plan:DeploymentPlan,signal?:AbortSignal):Record<string,unknown>{
  signal?.throwIfAborted();if(this.resolvingFailure)throw new RecoveryError('DEPLOYMENT_FAILURE_RESOLUTION_IN_PROGRESS');this.assertOwner();if(deploymentPlanHash(plan)!==this.owner.planHash)throw new RecoveryError('DEPLOYMENT_PLAN_CHANGED');
  if(existsSync(join(this.root,'deployment-lock/failed-recovery.json')))throw new RecoveryError('DEPLOYMENT_FAILURE_RESOLUTION_IN_PROGRESS');
  if(readFinalization(join(this.root,'deployment-lock'),this.plan,this.owner))throw new RecoveryError('DEPLOYMENT_FINALIZATION_IN_PROGRESS');
  const text=privateText(join(this.root,'latest-verified-deployment.json'));if(digest(text)!==this.owner.baselineSha256)throw new RecoveryError('DEPLOYMENT_CANONICAL_CHANGED');
  const canonical=checkCanonical(plan,text);
  signal?.throwIfAborted();return canonical;
 }
 /** Archive an explicitly failed monitor recovery after read-only proof of the
  * exact rollback and unchanged collateral state. Never marks health successful,
  * advances the journal, rewrites canonical state, or permits operation replay. */
 async resolveFailedMonitorRollback(journal:RecoveryJournal,verify:(plan:Readonly<DeploymentPlan>,signal:AbortSignal)=>Promise<{observation:DeploymentObservation;evidenceDigest:string;reason:'MONITOR_UNAVAILABLE_AFTER_ROLLBACK'}>,signal:AbortSignal):Promise<void>{
  if(this.resolvingFailure)throw new RecoveryError('DEPLOYMENT_FAILURE_RESOLUTION_IN_PROGRESS');
  const directory=join(this.root,'deployment-lock'),path=join(directory,'failed-recovery.json');
  const check=()=>{signal.throwIfAborted();this.assertOwner();if(!recoveryTarget(this.plan.worker).monitor||readFinalization(directory,this.plan,this.owner))throw new RecoveryError('DEPLOYMENT_FAILURE_RESOLUTION_UNSAFE');const current=privateText(join(this.root,'latest-verified-deployment.json'));if(digest(current)!==this.owner.baselineSha256)throw new RecoveryError('DEPLOYMENT_CANONICAL_CHANGED');checkCanonical(this.plan,current);};
  check();this.resolvingFailure=true;
  try{
   const state=await journal.read();validateRecoveryState(state);if(state.planHash!==this.owner.planHash||state.phase!=='rollback-intent')throw new RecoveryError('DEPLOYMENT_FAILURE_RESOLUTION_UNSAFE');
   const result=await verify(this.plan,signal);check();
   if(JSON.stringify(await journal.read())!==JSON.stringify(state))throw new RecoveryError('DEPLOYMENT_JOURNAL_CHANGED');
   const observed=result.observation;
   if(!result||Object.keys(result).sort().join(',')!=='evidenceDigest,observation,reason'||!observed||Object.keys(observed).sort().join(',')!=='deploymentId,operationId,version'||observed.version!==this.plan.baselineVersion||observed.operationId!==rollbackOperationId(this.plan.operationId)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(observed.deploymentId)||observed.deploymentId===this.plan.baselineDeploymentId||result.reason!=='MONITOR_UNAVAILABLE_AFTER_ROLLBACK'||!/^[a-f0-9]{64}$/.test(result.evidenceDigest))throw new RecoveryError('DEPLOYMENT_FAILURE_PROOF_INVALID');
   const record=JSON.stringify({v:1,planHash:this.owner.planHash,journal:state,...result})+'\n',existing=existsSync(path);
   if(readdirSync(directory).sort().join(',')!==(existing?'failed-recovery.json,owner.json':'owner.json'))throw new RecoveryError('DEPLOYMENT_LEASE_DIRECTORY_CHANGED');
   if(existing&&privateText(path)!==record)throw new RecoveryError('DEPLOYMENT_FAILURE_PROOF_CHANGED');
   const archive=join(this.root,'deployment-recovery-failed-'+this.plan.operationId);if(existsSync(archive))throw new RecoveryError('DEPLOYMENT_ALREADY_RESOLVED_FAILED');
   if(!existing){atomicText(path,record,this.root);syncDirectory(directory);}
   check();renameSync(directory,archive);syncDirectory(this.root);
  }finally{this.resolvingFailure=false;if(!existsSync(directory))this.close();}
 }
 /** Persist terminal evidence before replacing canonical bytes. Safe to resume, without provider writes. */
 async finalize(journal:RecoveryJournal,providerSnapshotPath?:string,assetEvidencePath?:string,schemaEvidencePath?:string):Promise<void>{
  this.assertOwner();const state=await journal.read();terminalState(state,this.owner.planHash);this.assertOwner();
  const directory=join(this.root,'deployment-lock'),path=join(this.root,'latest-verified-deployment.json');
  let receipt=readFinalization(directory,this.plan,this.owner);const current=privateText(path);
  if(receipt){if(providerSnapshotPath!==undefined&&providerSnapshotPath!==receipt.snapshot?.path)throw new RecoveryError('DEPLOYMENT_SNAPSHOT_CHANGED');if(assetEvidencePath!==undefined&&assetEvidencePath!==receipt.assets?.path)throw new RecoveryError('DEPLOYMENT_ASSET_PROOF_CHANGED');if(schemaEvidencePath!==undefined&&schemaEvidencePath!==receipt.schema?.path)throw new RecoveryError('DEPLOYMENT_SCHEMA_PROOF_CHANGED');if(JSON.stringify(state)!==JSON.stringify(receipt.terminal))throw new RecoveryError('DEPLOYMENT_FINALIZATION_INVALID');}
  else{
   this.assert(this.plan);const snapshot=providerSnapshotPath===undefined?undefined:{path:providerSnapshotPath,sha256:digest(privateText(providerSnapshotPath))},assets=assetEvidencePath===undefined?undefined:{path:assetEvidencePath,sha256:digest(privateText(assetEvidencePath,assetProofLimit))},schema=schemaEvidencePath===undefined?undefined:{path:schemaEvidencePath,sha256:digest(privateText(schemaEvidencePath))};
   receipt={v:1,planHash:this.owner.planHash,terminal:state,before:current,after:finalizedRecord(this.plan,state,current,snapshot,assets,schema),...(snapshot?{snapshot}:{}),...(assets?{assets}:{}),...(schema?{schema}:{})};
   atomicText(join(directory,'finalization.json'),JSON.stringify(receipt)+'\n',this.root);syncDirectory(directory);
  }
  if(current!==receipt.before&&current!==receipt.after)throw new RecoveryError('DEPLOYMENT_CANONICAL_CHANGED');
  this.assertOwner();if(current!==receipt.after)atomicText(path,receipt.after,this.root);
 }
 /** Explicitly abandon preparation only before any durable activation intent.
  * Keep the journal and archive the marker; the cancelled operation ID cannot recur.
  */
 async cancelBeforeIntent(journal:RecoveryJournal):Promise<void>{
  this.assert(this.plan);const state=await journal.read();
  if(state){validateRecoveryState(state);if(state.planHash!==this.owner.planHash||state.phase!=='prepared')throw new RecoveryError('DEPLOYMENT_CANCELLATION_UNSAFE');}
  this.assert(this.plan);const directory=join(this.root,'deployment-lock');
  if(JSON.stringify(readdirSync(directory).sort())!==JSON.stringify(['owner.json']))throw new RecoveryError('DEPLOYMENT_CANCELLATION_UNSAFE');
  const archive=join(this.root,'deployment-recovery-cancelled-'+this.plan.operationId);if(existsSync(archive))throw new RecoveryError('DEPLOYMENT_ALREADY_CANCELLED');
  renameSync(directory,archive);syncDirectory(this.root);this.close();
 }
 /** Finish an already durable finalization receipt without re-running provider or user writes.
  * Returns false when fresh terminal proof collection is still required.
  * Success is historical bookkeeping, not a new assertion of provider health.
  */
 async resumeFinalization(journal:RecoveryJournal):Promise<boolean>{
  this.assertOwner();
  if(!readFinalization(join(this.root,'deployment-lock'),this.plan,this.owner))return false;
  await this.finalize(journal);await this.release(journal);return true;
 }
 /** Archive the intact lock atomically; never leave an ownerless lock directory on crash. */
 async release(journal:RecoveryJournal):Promise<void>{
  this.assertOwner();const state=await journal.read();terminalState(state,this.owner.planHash);this.assertOwner();
  const directory=join(this.root,'deployment-lock'),receipt=readFinalization(directory,this.plan,this.owner);
  if(!receipt||JSON.stringify(state)!==JSON.stringify(receipt.terminal)||privateText(join(this.root,'latest-verified-deployment.json'))!==receipt.after)throw new RecoveryError('DEPLOYMENT_FINALIZATION_REQUIRED');
  if(JSON.stringify(readdirSync(directory).sort())!==JSON.stringify(['finalization.json','owner.json']))throw new RecoveryError('DEPLOYMENT_LEASE_DIRECTORY_CHANGED');
  const archive=archivePath(this.root,this.plan);if(existsSync(archive))throw new RecoveryError('DEPLOYMENT_ALREADY_FINALIZED');
  renameSync(directory,archive);syncDirectory(this.root);this.close();
 }
 /** Read-only continuity scope check across canonical finalization and archival.
  * Accept only the exact starting bytes or this plan's fully validated receipt.
  * This is not deployment authorization or a provider-health assertion.
  */
 static assertObservedCanonical(root:string,plan:DeploymentPlan,before:string):void{
  if(!isAbsolute(root))throw new RecoveryError('DEPLOYMENT_LEASE_PATH_INVALID');privateDirectory(root);
  const hash=deploymentPlanHash(plan);checkCanonical(plan,before);
  const current=privateText(join(root,'latest-verified-deployment.json'));if(current===before)return;
  // A release can atomically rename its active directory to the archive between
  // reads. Retry only that local ENOENT race; never bypass an invalid receipt.
  for(let attempt=0;attempt<2;attempt++){
   const archived=archivePath(root,plan),directory=existsSync(archived)?archived:join(root,'deployment-lock');
   try{
    privateDirectory(directory);const owner:Owner=JSON.parse(privateText(join(directory,'owner.json'),4096));
    if(owner.protocol!==protocol||owner.operationId!==plan.operationId||owner.planHash!==hash||owner.source!==plan.candidateSource||owner.baselineSha256!==digest(before))throw new RecoveryError('DEPLOYMENT_FINALIZATION_INVALID');
    const receipt=readFinalization(directory,plan,owner);
    if(!receipt||receipt.before!==before||receipt.after!==current)throw new RecoveryError('DEPLOYMENT_CANONICAL_CHANGED');
    return;
   }catch(error){if(attempt===0&&(error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  }
 }
 /** Historical completion receipt, not a claim about current provider health or a later deployment. */
 static async completed(root:string,plan:DeploymentPlan,journal:RecoveryJournal):Promise<Record<string,unknown>|null>{
  if(!isAbsolute(root))throw new RecoveryError('DEPLOYMENT_LEASE_PATH_INVALID');privateDirectory(root);const hash=deploymentPlanHash(plan),directory=archivePath(root,plan);
  if(!existsSync(directory))return null;privateDirectory(directory);
  const owner:Owner=JSON.parse(privateText(join(directory,'owner.json'),4096));
  if(owner.protocol!==protocol||owner.operationId!==plan.operationId||owner.planHash!==hash||owner.source!==plan.candidateSource)throw new RecoveryError('DEPLOYMENT_FINALIZATION_INVALID');
  const receipt=readFinalization(directory,plan,owner),state=await journal.read();terminalState(state,hash);
  if(!receipt||JSON.stringify(state)!==JSON.stringify(receipt.terminal))throw new RecoveryError('DEPLOYMENT_FINALIZATION_INVALID');
  return JSON.parse(receipt.after);
 }
 /** Releases the kernel lock only. Unknown outcomes keep the persistent marker for same-plan resume. */
 close():void{if(this.resolvingFailure)throw new RecoveryError('DEPLOYMENT_FAILURE_RESOLUTION_IN_PROGRESS');if(this.held){this.held=false;try{this.db.exec('ROLLBACK');}finally{this.db.close();}}}
}

/** Enforce lease/canonical checks at the I/O boundary as well as authorization.
 * The supplied authorize callback must additionally validate real release evidence. */
export function leasedDeploymentPorts(plan:DeploymentPlan,lease:FileDeploymentLease,journal:RecoveryJournal,ports:DeploymentPorts):DeploymentPorts{
 const hash=deploymentPlanHash(plan);plan=Object.freeze({...plan,...(plan.readerFloorPromotion?{readerFloorPromotion:Object.freeze({...plan.readerFloorPromotion})}:{}),compatibleRollbackVersions:Object.freeze([...plan.compatibleRollbackVersions])});
 const sent=new Set<string>();
 return{
  async authorize(input,direction,signal){lease.assert(input,signal);if(deploymentPlanHash(input)!==hash)throw new RecoveryError('DEPLOYMENT_PLAN_CHANGED');await ports.authorize(input,direction,signal);lease.assert(input,signal);},
  async observe(signal){lease.assert(plan,signal);return ports.observe(signal);},
  async verify(version,signal){lease.assert(plan,signal);if(![plan.candidateVersion,plan.baselineVersion].includes(version))throw new RecoveryError('DEPLOYMENT_VERSION_NOT_AUTHORIZED');return ports.verify(version,signal);},
  async deploy(version,operationId,signal){
   lease.assert(plan,signal);const state=await journal.read();validateRecoveryState(state);
   const activation=version===plan.candidateVersion&&operationId===plan.operationId&&state.phase==='activation-intent';
   const rollback=version===plan.baselineVersion&&operationId===rollbackOperationId(plan.operationId)&&state.phase==='rollback-intent';
   if(state.planHash!==hash||!activation&&!rollback||sent.has(operationId))throw new RecoveryError('DEPLOYMENT_WRITE_NOT_AUTHORIZED');
   lease.assert(plan,signal);sent.add(operationId);await ports.deploy(version,operationId,signal);
  },
 };
}
