import {readProviderJson} from './provider-response-body.ts';
/** Explicit reconciliation only: never uploads or activates a version. */
import {readActivationManifest} from './release-activation-cli.ts';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {FileRecoveryJournal} from './deployment-recovery-journal.ts';
import {pathToFileURL} from 'node:url';
export async function reconcileFailedActivation(path:string,env:NodeJS.ProcessEnv){
 const manifest=readActivationManifest(path),{plan,review}=manifest,account=env.CLOUDFLARE_ACCOUNT_ID??'',token=env.CLOUDFLARE_API_TOKEN??'';
 if(!/^[a-f0-9]{32}$/.test(account)||token.length<20)throw Error('PROVIDER_CONFIGURATION_INVALID');
 const lease=FileDeploymentLease.acquire(review.execution.root,plan),journal=new FileRecoveryJournal(review.execution.journalDirectory);
 try{await lease.reconcileFailedActivation(journal,account,async()=>{
  const base='https://api.cloudflare.com/client/v4/accounts/'+account;
  async function get(url:string){lease.assert(plan);const r=await fetch(url,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok){await r.body?.cancel().catch(()=>{});throw Error('RECONCILIATION_READ_FAILED');}return await readProviderJson(r,4*1024*1024) as {success?:boolean;result?:unknown[];result_info?:{cursor?:string}};}
  const endpoint=base+'/workers/scripts/'+plan.worker+'/deployments',before=await get(endpoint),audit:{success:boolean;result:unknown[]}={success:true,result:[]};
  // Read the complete recent audit window, preserving duplicate/conflicting
  // records for rejection by the verifier. No mutation retries are involved.
  let cursor:string|undefined;const seen=new Set<string>();const until=new Date().toISOString(),since=new Date(Date.now()-86400000).toISOString();
  for(let page=0;;page++){
   if(page>=100)throw Error('RECONCILIATION_AUDIT_INCOMPLETE');
   const url=new URL(base+'/logs/audit');url.searchParams.set('since',since);url.searchParams.set('before',until);url.searchParams.set('limit','1000');url.searchParams.set('resource_id',plan.worker);if(cursor)url.searchParams.set('cursor',cursor);
   const value=await get(url.toString());if(value.success!==true||!Array.isArray(value.result))throw Error('RECONCILIATION_AUDIT_INVALID');audit.result.push(...value.result.filter((x:any)=>x.resource?.request?.annotations?.['workers/message']==='porchday-recovery:'+plan.operationId).map((x:any)=>({id:x.id,account:{id:x.account?.id},action:x.action,resource:x.resource,raw:x.raw})));
   cursor=value.result_info?.cursor;if(!cursor)break;if(seen.has(cursor))throw Error('RECONCILIATION_AUDIT_INCOMPLETE');seen.add(cursor);
  }
  return {before,audit,after:await get(endpoint)};
 });return {status:'failed-activation-reconciled',operationId:plan.operationId,providerWrites:0};}finally{lease.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const [path,...extra]=process.argv.slice(2);if(!path||extra.length)throw Error('RECONCILIATION_ARGUMENTS');reconcileFailedActivation(path,process.env).then(x=>console.log(JSON.stringify(x))).catch(()=>{console.error('RECONCILIATION_UNPROVEN');process.exitCode=1;});}
