import {constants,openSync,closeSync,fsyncSync,fstatSync,readFileSync,writeFileSync,linkSync,unlinkSync,realpathSync,lstatSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {deploymentPlanHash,deploymentTarget,type DeploymentPlan} from './deployment-recovery.ts';
import {ghTransport,type GitHubTransport} from './external-monitor-github.ts';
export const releaseAlertReasons=['activation-unconfirmed','rollback-unconfirmed','verification-unavailable','observation-unavailable','concurrent-change','command-failed','release-overdue','release-state-unreadable','notification-drill'] as const;
export type ReleaseAlert={v:1;operationId:string;planHash:string;worker:string;reason:typeof releaseAlertReasons[number];at:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validateReleaseAlert(value:unknown):asserts value is ReleaseAlert{
 const e=value as ReleaseAlert;
 if(!e||Object.keys(e).sort().join(',')!=='at,operationId,planHash,reason,v,worker'||e.v!==1||typeof e.operationId!=='string'||typeof e.planHash!=='string'||typeof e.worker!=='string'||!uuid.test(e.operationId)||!/^[a-f0-9]{64}$/.test(e.planHash)||!releaseAlertReasons.includes(e.reason)||typeof e.at!=='string'||!Number.isFinite(Date.parse(e.at))||new Date(e.at).toISOString()!==e.at)throw Error('RELEASE_ALERT_INVALID');
 deploymentTarget(e.worker);
}
export function releaseAlertBody(event:ReleaseAlert){
 validateReleaseAlert(event);
 return `<!-- porchday-release-attention:${event.operationId}:${event.planHash} -->\n@andyk @bobbyhwilder\n\n${event.reason==='notification-drill'?'Notification drill: no deployment failure is being reported.':'A release needs operator attention.'}\nWorker: ${event.worker}\nObserved at: ${event.at}\nReason: ${event.reason}\nOperation: ${event.operationId}\nPlan: ${event.planHash}\n\nInspect the retained private manifest, journal and current provider state. Resume only the same operation after reconciliation. Do not replay an uncertain write, replace its operation ID, or remove its deployment lock. This alert does not by itself establish a site outage. See docs/release-upload.md.\n`;
}
/** Immutable outbox: one sanitized notification per operation; later outcomes stay in private journals. */
export function queueReleaseAlert(directory:string,plan:DeploymentPlan,reason:ReleaseAlert['reason'],now=new Date()):ReleaseAlert{
 const event:ReleaseAlert={v:1,operationId:plan.operationId,planHash:deploymentPlanHash(plan),worker:plan.worker,reason,at:now.toISOString()};validateReleaseAlert(event);
 const s=lstatSync(directory);if(!isAbsolute(directory)||realpathSync(directory)!==directory||!s.isDirectory()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('RELEASE_ALERT_DIRECTORY_INVALID');
 const path=join(directory,'attention-'+plan.operationId+'.json'),temporary=join(directory,'attention-tmp-'+randomUUID());
 const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{writeFileSync(fd,JSON.stringify(event)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 try{linkSync(temporary,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  const input=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=fstatSync(input);if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>4096)throw Error('RELEASE_ALERT_RECORD_INVALID');const prior=JSON.parse(readFileSync(input,'utf8'));validateReleaseAlert(prior);if(prior.operationId!==event.operationId||prior.planHash!==event.planHash||prior.worker!==event.worker)throw Error('RELEASE_ALERT_RECORD_CHANGED');return prior;}finally{closeSync(input);}
 }finally{unlinkSync(temporary);}
 const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}return event;
}
const issue='/repos/porchday/porchday/issues/3';
/** Delivery means the exact bot comment is observed, never merely workflow dispatch acceptance. */
export async function deliverReleaseAlert(event:ReleaseAlert,options:{transport?:GitHubTransport;bot?:boolean;reconcileOnly?:boolean;beforeDispatch?:()=>void|Promise<void>}={}):Promise<'delivered'|'pending'>{
 const body=releaseAlertBody(event),marker=body.split('\n')[0],transport=options.transport??ghTransport;
 const target=await transport('GET',issue) as {title?:string;pull_request?:unknown};
 if(target.pull_request||target.title!=='Make release verification handle deployment convergence and preserve precise failure evidence')throw Error('RELEASE_ALERT_ISSUE_CHANGED');
 for(let page=1;page<=100;page++){
  const comments=await transport('GET',issue+`/comments?per_page=100&page=${page}`) as {body?:string;user?:{login?:string;type?:string}}[];
  if(!Array.isArray(comments)||comments.length>100)throw Error('RELEASE_ALERT_RESPONSE_INVALID');
  const bot=comments.filter(c=>c.user?.login==='github-actions[bot]'&&c.user.type==='Bot');
  if(bot.some(c=>c.body===body))return 'delivered';
  if(bot.some(c=>typeof c.body==='string'&&c.body.startsWith(marker)&&c.body!==body))throw Error('RELEASE_ALERT_EVENT_CONFLICT');
  if(comments.length===100)continue;
  if(options.reconcileOnly)return 'pending';
  if(options.bot){await transport('POST',issue+'/comments',{body});return deliverReleaseAlert(event,{transport,reconcileOnly:true});}
  await options.beforeDispatch?.();
  await transport('POST','/repos/porchday/porchday/actions/workflows/release-alert-relay.yml/dispatches',{ref:'main',inputs:{operation_id:event.operationId,payload:JSON.stringify(event)}});
  return 'pending';
 }
 throw Error('RELEASE_ALERT_ISSUE_ROTATION_REQUIRED');
}
