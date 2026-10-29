import {DatabaseSync} from 'node:sqlite';
import {constants,closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import {uploadTarget} from './release-upload-target.ts';

export type UploadPlan={operationId:string;worker:string;source:string;canonicalSha256:string;evidenceDigest:string};
const protocol='porchday-release-upload-sqlite-v1';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
export function uploadPlanHash(plan:UploadPlan):string{
 uploadTarget(plan.worker);
 if(!uuid.test(plan.operationId)||!/^[a-f0-9]{40}$/.test(plan.source)||![plan.canonicalSha256,plan.evidenceDigest].every(value=>/^[a-f0-9]{64}$/.test(value))||Object.keys(plan).sort().join(',')!=='canonicalSha256,evidenceDigest,operationId,source,worker')throw Error('UPLOAD_PLAN_INVALID');
 return sha(JSON.stringify({operationId:plan.operationId,worker:plan.worker,source:plan.source,canonicalSha256:plan.canonicalSha256,evidenceDigest:plan.evidenceDigest}));
}
function directory(path:string){const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('UPLOAD_PERMISSIONS');}
function file(path:string,limit=2*1024*1024){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>limit)throw Error('UPLOAD_PERMISSIONS');}
function text(path:string,limit=2*1024*1024){file(path,limit);return readFileSync(path,'utf8');}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function exclusive(path:string,value:unknown,parent:string){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}sync(parent);}
type Owner={v:1;protocol:typeof protocol;owner:string;operationId:string;planHash:string;source:string;baselineSha256:string};
type Intent={v:1;planHash:string;operationId:string;at:string};
type Rejected={v:1;planHash:string;version:string;evidenceDigest:string;reason:string};
type Verified={v:1;planHash:string;version:string;evidenceDigest:string};
/** Shared kernel + persistent directory lock, including before a candidate version ID exists. */
export class FileUploadLease{
 private root:string;private db:DatabaseSync;private plan:UploadPlan;private owner:Owner;private held=true;private inFlight=false;
 private constructor(root:string,db:DatabaseSync,plan:UploadPlan,owner:Owner){this.root=root;this.db=db;this.plan=Object.freeze({...plan});this.owner=owner;}
 static acquire(root:string,plan:UploadPlan):FileUploadLease{
  if(!isAbsolute(root))throw Error('UPLOAD_PATH_INVALID');directory(root);const hash=uploadPlanHash(plan),database=join(root,'deployment-recovery.lock.sqlite');
  try{const fd=openSync(database,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);sync(root);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  file(database,Number.MAX_SAFE_INTEGER);let db:DatabaseSync;
  try{db=new DatabaseSync(database);try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}catch(error){db.close();throw error;}}catch{throw Error('UPLOAD_LEASE_BUSY');}
  try{
   if(existsSync(join(root,'release-upload-completed-'+plan.operationId)))throw Error('UPLOAD_ALREADY_COMPLETED');
   if(existsSync(join(root,'release-upload-rejected-'+plan.operationId)))throw Error('UPLOAD_ALREADY_REJECTED');
   if(existsSync(join(root,'release-upload-cancelled-'+plan.operationId)))throw Error('UPLOAD_ALREADY_CANCELLED');
   if(sha(text(join(root,'latest-verified-deployment.json')))!==plan.canonicalSha256)throw Error('UPLOAD_CANONICAL_CHANGED');
   const path=join(root,'deployment-lock'),owner:Owner={v:1,protocol,owner:'release-upload-'+plan.operationId,operationId:plan.operationId,planHash:hash,source:plan.source,baselineSha256:plan.canonicalSha256};
   let created=false;try{mkdirSync(path,{mode:0o700});created=true;sync(root);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   directory(path);
   if(created)exclusive(join(path,'owner.json'),owner,path);
   else{let existing:unknown;try{existing=JSON.parse(text(join(path,'owner.json'),4096));}catch{throw Error('UPLOAD_LEASE_HELD');}if(JSON.stringify(existing)!==JSON.stringify(owner))throw Error('UPLOAD_LEASE_HELD');}
   const lease=new FileUploadLease(root,db,plan,owner);lease.assert();lease.intent();lease.verified();lease.rejected();return lease;
  }catch(error){db.exec('ROLLBACK');db.close();throw error;}
 }
 assert(signal?:AbortSignal):void{
  signal?.throwIfAborted();if(!this.held)throw Error('UPLOAD_LEASE_NOT_HELD');directory(this.root);directory(join(this.root,'deployment-lock'));
  if(text(join(this.root,'deployment-lock/owner.json'),4096)!==JSON.stringify(this.owner)+'\n')throw Error('UPLOAD_LEASE_CHANGED');
  if(sha(text(join(this.root,'latest-verified-deployment.json')))!==this.plan.canonicalSha256)throw Error('UPLOAD_CANONICAL_CHANGED');
 }
 assertPlan(plan:Readonly<UploadPlan>,signal?:AbortSignal):void{
  this.assert(signal);if(uploadPlanHash(plan)!==this.owner.planHash)throw Error('UPLOAD_PLAN_CHANGED');
 }
 private intent():Intent|null{
  const path=join(this.root,'deployment-lock/upload-intent.json');if(!existsSync(path))return null;
  let value:Intent;try{value=JSON.parse(text(path,4096));}catch{throw Error('UPLOAD_INTENT_INVALID');}
  if(value.v!==1||value.planHash!==this.owner.planHash||value.operationId!==this.plan.operationId||typeof value.at!=='string'||!Number.isFinite(Date.parse(value.at))||Object.keys(value).sort().join(',')!=='at,operationId,planHash,v')throw Error('UPLOAD_INTENT_INVALID');return value;
 }
 private verified():Verified|null{
  const path=join(this.root,'deployment-lock/upload-verified.json');if(!existsSync(path))return null;
  let value:Verified;try{value=JSON.parse(text(path,4096));}catch{throw Error('UPLOAD_VERIFIED_INVALID');}
  if(!this.intent()||value.v!==1||value.planHash!==this.owner.planHash||!uuid.test(value.version)||!/^[a-f0-9]{64}$/.test(value.evidenceDigest)||Object.keys(value).sort().join(',')!=='evidenceDigest,planHash,v,version')throw Error('UPLOAD_VERIFIED_INVALID');return value;
 }
 private rejected():Rejected|null{
  const path=join(this.root,'deployment-lock/upload-rejected.json');if(!existsSync(path))return null;
  let value:Rejected;try{value=JSON.parse(text(path,4096));}catch{throw Error('UPLOAD_REJECTION_INVALID');}
  if(!this.intent()||this.verified()||value.v!==1||value.planHash!==this.owner.planHash||!uuid.test(value.version)||!/^[a-f0-9]{64}$/.test(value.evidenceDigest)||!/^[A-Z][A-Z0-9_]{0,127}$/.test(value.reason)||Object.keys(value).sort().join(',')!=='evidenceDigest,planHash,reason,v,version')throw Error('UPLOAD_REJECTION_INVALID');return value;
 }
 /** Resolve a known, inactive rejected candidate only after read-only reconciliation proves
  * unchanged active routing and collateral state. Persist private evidence before returning
  * its digest. This archives failure, never success, and permanently forbids operation replay. */
 async rejectInactive(verify:(plan:Readonly<UploadPlan>,signal:AbortSignal)=>Promise<{version:string;evidenceDigest:string;reason:string}>,signal:AbortSignal):Promise<Rejected>{
  this.assert(signal);if(this.inFlight)throw Error('UPLOAD_IN_PROGRESS');if(!this.intent())throw Error('UPLOAD_INTENT_REQUIRED');if(this.verified())throw Error('UPLOAD_ALREADY_VERIFIED');this.inFlight=true;
  try{
   const result=await verify(this.plan,signal);this.assert(signal);
   if(!uuid.test(result.version)||!/^[a-f0-9]{64}$/.test(result.evidenceDigest)||!/^[A-Z][A-Z0-9_]{0,127}$/.test(result.reason))throw Error('UPLOAD_REJECTION_INVALID');
   const record:Rejected={v:1,planHash:this.owner.planHash,version:result.version,evidenceDigest:result.evidenceDigest,reason:result.reason},existing=this.rejected();
   if(existing&&JSON.stringify(existing)!==JSON.stringify(record))throw Error('UPLOAD_REJECTION_CHANGED');
   const parent=join(this.root,'deployment-lock'),archive=join(this.root,'release-upload-rejected-'+this.plan.operationId);
   if(readdirSync(parent).sort().join(',')!==(existing?'owner.json,upload-intent.json,upload-rejected.json':'owner.json,upload-intent.json'))throw Error('UPLOAD_DIRECTORY_CHANGED');
   if(existsSync(archive))throw Error('UPLOAD_ALREADY_REJECTED');
   if(!existing)exclusive(join(parent,'upload-rejected.json'),record,parent);
   this.assert(signal);renameSync(parent,archive);sync(this.root);return record;
  }finally{this.inFlight=false;if(!existsSync(join(this.root,'deployment-lock')))this.close();}
 }
 /** Read historical completion after a crash at archive; never permits a new send. */
 static completed(root:string,plan:UploadPlan):Verified|null{
  if(!isAbsolute(root))throw Error('UPLOAD_PATH_INVALID');directory(root);const hash=uploadPlanHash(plan),path=join(root,'release-upload-completed-'+plan.operationId);
  if(!existsSync(path))return null;directory(path);
  if(readdirSync(path).sort().join(',')!=='owner.json,upload-intent.json,upload-verified.json')throw Error('UPLOAD_DIRECTORY_CHANGED');
  const owner:Owner={v:1,protocol,owner:'release-upload-'+plan.operationId,operationId:plan.operationId,planHash:hash,source:plan.source,baselineSha256:plan.canonicalSha256};
  if(text(join(path,'owner.json'),4096)!==JSON.stringify(owner)+'\n')throw Error('UPLOAD_LEASE_CHANGED');
  const intent=JSON.parse(text(join(path,'upload-intent.json'),4096)),result=JSON.parse(text(join(path,'upload-verified.json'),4096));
  if(intent.v!==1||intent.planHash!==hash||intent.operationId!==plan.operationId||typeof intent.at!=='string'||!Number.isFinite(Date.parse(intent.at))||Object.keys(intent).sort().join(',')!=='at,operationId,planHash,v')throw Error('UPLOAD_INTENT_INVALID');
  if(result.v!==1||result.planHash!==hash||!uuid.test(result.version)||!/^[a-f0-9]{64}$/.test(result.evidenceDigest)||Object.keys(result).sort().join(',')!=='evidenceDigest,planHash,v,version')throw Error('UPLOAD_VERIFIED_INVALID');return result;
 }
 /** Existing intent always means reconcile, even if no request reached the provider. */
 async dispatchOnce(authorize:(plan:Readonly<UploadPlan>,signal:AbortSignal)=>Promise<void>,send:(operationId:string,signal:AbortSignal)=>Promise<void>,signal:AbortSignal):Promise<'dispatched'|'reconcile'> {
  this.assert(signal);if(this.inFlight)throw Error('UPLOAD_IN_PROGRESS');if(this.rejected())throw Error('UPLOAD_ALREADY_REJECTED');if(this.intent())return 'reconcile';this.inFlight=true;
  try{
   await authorize(this.plan,signal);this.assert(signal);
   const parent=join(this.root,'deployment-lock');exclusive(join(parent,'upload-intent.json'),{v:1,planHash:this.owner.planHash,operationId:this.plan.operationId,at:new Date().toISOString()},parent);
   this.assert(signal);
   try{await send(this.plan.operationId,signal);this.assert(signal);return 'dispatched';}catch{return 'reconcile';}
  }finally{this.inFlight=false;}
 }
 /** Read-only reconciliation must verify exact upload bytes/resources and unchanged active routing.
  * Persist its private evidence first and return that evidence's SHA-256. Success is not activation. */
 async reconcile(verify:(plan:Readonly<UploadPlan>,signal:AbortSignal)=>Promise<{version:string;evidenceDigest:string}>,signal:AbortSignal):Promise<void>{
  this.assert(signal);if(this.inFlight)throw Error('UPLOAD_IN_PROGRESS');if(!this.intent())throw Error('UPLOAD_INTENT_REQUIRED');if(this.rejected())throw Error('UPLOAD_ALREADY_REJECTED');this.inFlight=true;
  try{
   const result=await verify(this.plan,signal);this.assert(signal);
   if(!uuid.test(result.version)||!/^[a-f0-9]{64}$/.test(result.evidenceDigest))throw Error('UPLOAD_VERIFICATION_INVALID');
   const record:Verified={v:1,planHash:this.owner.planHash,version:result.version,evidenceDigest:result.evidenceDigest},existing=this.verified();
   if(existing){if(JSON.stringify(existing)!==JSON.stringify(record))throw Error('UPLOAD_VERIFICATION_CHANGED');}
   else exclusive(join(this.root,'deployment-lock/upload-verified.json'),record,join(this.root,'deployment-lock'));
  }finally{this.inFlight=false;}
 }
 /** Cancel only an owned preparation with no durable dispatch intent; preserve its owner record. */
 cancelBeforeDispatch():void{
  this.assert();if(this.inFlight)throw Error('UPLOAD_IN_PROGRESS');
  const parent=join(this.root,'deployment-lock'),archive=join(this.root,'release-upload-cancelled-'+this.plan.operationId);
  if(this.intent()||this.verified())throw Error('UPLOAD_CANCELLATION_UNSAFE');
  if(readdirSync(parent).sort().join(',')!=='owner.json')throw Error('UPLOAD_DIRECTORY_CHANGED');
  if(existsSync(archive))throw Error('UPLOAD_ALREADY_CANCELLED');
  renameSync(parent,archive);sync(this.root);this.close();
 }
 /** Archive only reconciled inactive uploads. Does not change canonical active state. */
 release():Verified{
  this.assert();if(this.inFlight)throw Error('UPLOAD_IN_PROGRESS');const record=this.verified();if(!record)throw Error('UPLOAD_RECONCILIATION_REQUIRED');
  const parent=join(this.root,'deployment-lock'),archive=join(this.root,'release-upload-completed-'+this.plan.operationId);
  if(readdirSync(parent).sort().join(',')!=='owner.json,upload-intent.json,upload-verified.json')throw Error('UPLOAD_DIRECTORY_CHANGED');
  if(existsSync(archive))throw Error('UPLOAD_ALREADY_COMPLETED');renameSync(parent,archive);sync(this.root);this.close();return record;
 }
 /** Unknown operations retain their marker. Closing never permits dispatch from a resumed intent. */
 close():void{if(this.inFlight)throw Error('UPLOAD_IN_PROGRESS');if(this.held){this.held=false;try{this.db.exec('ROLLBACK');}finally{this.db.close();}}}
}
