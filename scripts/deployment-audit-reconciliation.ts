import {isDeepStrictEqual} from 'node:util';
import {deploymentPlanHash,type DeploymentPlan} from './deployment-recovery.ts';

/** A failed audit event alone (especially HTTP 5xx) does not prove absence of
 * side effects. Reconciliation also requires the unchanged original deployment
 * to remain the newest provider deployment, before AND after the audit read.
 * This authorizes abandonment, never retry of the original operation. */
export function verifyFailedActivation(plan:DeploymentPlan,accountId:string,audit:unknown,before:unknown,after:unknown,notBefore:string,now=Date.now()){
 const fail=()=>{throw Error('DEPLOYMENT_AUDIT_RECONCILIATION_UNPROVEN');};
 if(!Number.isFinite(now)||!/^[a-f0-9]{32}$/.test(accountId)||!Number.isFinite(Date.parse(notBefore)))fail();
 const history=(value:any)=>{
  if(value?.success!==true||!Array.isArray(value.result?.deployments)||!value.result.deployments.length)fail();
  const rows=value.result.deployments,first=rows[0];
  if(first.id!==plan.baselineDeploymentId||!isDeepStrictEqual(first.versions,[{version_id:plan.baselineVersion,percentage:100}]))fail();
  if(rows.some((x:any)=>x.annotations?.['workers/message']==='porchday-recovery:'+plan.operationId||x.versions?.some((v:any)=>v.version_id===plan.candidateVersion)))fail();
  return first;
 };
 const original=history(before);if(!isDeepStrictEqual(original,history(after)))fail();
 const value=audit as any;
 if(value?.success!==true||!Array.isArray(value.result)||value.result_info?.cursor)fail();
 const matches=value.result.filter((x:any)=>x.resource?.request?.annotations?.['workers/message']==='porchday-recovery:'+plan.operationId);
 if(matches.length!==1)fail();const event=matches[0],time=Date.parse(event.action?.time);
 if(event.account?.id!==accountId||event.action?.description!=='Create Worker Deployment'||event.action?.type!=='create'||event.action?.result!=='failure'||event.resource?.id!==plan.worker||event.resource?.type!=='scripts.deployments'||event.raw?.method!=='POST'||event.raw?.uri!=='/accounts/'+accountId+'/workers/scripts/'+plan.worker+'/deployments'||!Number.isInteger(event.raw?.status_code)||event.raw.status_code<400||event.raw.status_code>599||!Number.isFinite(time)||time<Date.parse(notBefore)||now-time<300000||now-time>86400000)fail();
 if(!isDeepStrictEqual(event.resource.request,{strategy:'percentage',versions:[{version_id:plan.candidateVersion,percentage:100}],annotations:{'workers/message':'porchday-recovery:'+plan.operationId}}))fail();
 return {version:1 as const,operationId:plan.operationId,planHash:deploymentPlanHash(plan),disposition:'provider-failed-baseline-retained' as const,auditId:event.id,providerStatus:event.raw.status_code,providerTime:event.action.time,observedAt:new Date(now).toISOString(),baselineDeploymentId:plan.baselineDeploymentId};
}
