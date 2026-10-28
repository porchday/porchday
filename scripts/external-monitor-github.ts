import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {alertBody, type AlertEvent} from './external-monitor-alerts.ts';
const exec=promisify(execFile);
export type GitHubTransport=(method:'GET'|'POST',path:string,body?:object)=>Promise<unknown>;

/** Use the existing gh credential store; never retain the token in monitor state. */
export const ghTransport:GitHubTransport=async(method,path,body)=>{
 const args=['api','--hostname','github.com','--method',method,path];
 if(body)args.push('--input','-');
 try{
  // execFile does not provide an input option. Write JSON directly to stdin.
  if(body)return await new Promise((resolve,reject)=>{
   const child=execFile(process.env.PORCHDAY_MONITOR_GH_PATH??'/opt/homebrew/bin/gh',args,{timeout:15000,maxBuffer:1048576},(error,stdout)=>{
    if(error){reject(Error('GITHUB_REQUEST_FAILED'));return;}
    try{resolve(stdout.trim()?JSON.parse(stdout):null);}catch{reject(Error('GITHUB_RESPONSE_INVALID'));}
   });
   child.stdin?.on('error',()=>{});child.stdin?.end(JSON.stringify(body));
  });
  const result=await exec(process.env.PORCHDAY_MONITOR_GH_PATH??'/opt/homebrew/bin/gh',args,{timeout:15000,maxBuffer:1048576});
  return JSON.parse(result.stdout);
 }catch{throw Error('GITHUB_REQUEST_FAILED');}
};

/** Read only exact, machine-generated bot events. Human text and drills are not state. */
export async function latestHostedEvent(issue:number,transport:GitHubTransport=ghTransport):Promise<AlertEvent|null>{
 if(!Number.isSafeInteger(issue)||issue<1)throw Error('INVALID_MONITOR_ISSUE');
 const path=`/repos/porchday/porchday/issues/${issue}`;
 const target=await transport('GET',path) as {title?:string;pull_request?:unknown};
 if(target.pull_request||target.title!=='External production availability alerts (github-backup)')throw Error('MONITOR_ISSUE_MISMATCH');
 let latest:AlertEvent|null=null,latestId=0;
 for(let page=1;page<=100;page++){
  const comments=await transport('GET',path+`/comments?per_page=100&page=${page}`) as {id?:number;body?:string;user?:{login?:string;type?:string}}[];
  if(!Array.isArray(comments))throw Error('GITHUB_RESPONSE_INVALID');
  for(const comment of comments){
   if(comment.user?.login!=='github-actions[bot]'||comment.user.type!=='Bot'||typeof comment.body!=='string'||!Number.isSafeInteger(comment.id)||comment.id!<=0)continue;
   const body=comment.body,id=/^<!-- porchday-external-monitor:github-backup:([a-zA-Z0-9-]{1,64}) -->\n/.exec(body)?.[1];
   const at=/^Observed at: (\S+)$/m.exec(body)?.[1];
   const kind=body.includes('\nExternal availability check failed.\n')?'outage':body.includes('\nExternal availability checks recovered.\n')?'recovery':null;
   if(!id||!at||!kind)continue;
   const failedChecks=kind==='outage'?(/^Failed checks: (.*)$/m.exec(body)?.[1]??'').split(', '):[];
   const event:AlertEvent={id,kind,at,failedChecks};
   try{if(alertBody(event,'github-backup')===body&&comment.id!>latestId){latest=event;latestId=comment.id!;}}catch{/* Untrusted text is never executed or echoed. */}
  }
  if(comments.length<100)return latest;
 }
 throw Error('MONITOR_ISSUE_ROTATION_REQUIRED');
}

/** A failed or missing previous execution must not disappear when the next probe is healthy. */
export async function previousHostedExecutionFailed(runId:string,transport:GitHubTransport=ghTransport,now=Date.now()):Promise<boolean>{
 const current=Number(runId);
 if(!/^\d+$/.test(runId)||!Number.isSafeInteger(current)||current<1)throw Error('INVALID_WORKFLOW_RUN');
 const response=await transport('GET','/repos/porchday/porchday/actions/workflows/external-monitor.yml/runs?branch=main&per_page=10&exclude_pull_requests=true') as {workflow_runs?:{id:number;head_branch:string;event:string;status:string;conclusion:string|null;updated_at:string}[]};
 if(!Array.isArray(response.workflow_runs))throw Error('GITHUB_RESPONSE_INVALID');
 const previous=response.workflow_runs.filter(run=>Number.isSafeInteger(run.id)&&run.id<current&&run.head_branch==='main'&&['schedule','workflow_dispatch'].includes(run.event)).sort((a,b)=>b.id-a.id)[0];
 if(!previous)return false;
 const updated=Date.parse(previous.updated_at);
 if(!Number.isFinite(updated)||updated>now+30000)throw Error('GITHUB_RESPONSE_INVALID');
 return previous.status!=='completed'||previous.conclusion!=='success'||now-updated>12*60000;
}

/** Reconcile an uncertain comment write using its persisted event marker before retrying. */
export async function deliver(issue:number,event:AlertEvent,source:'operator-mac'|'github-backup',options:{transport?:GitHubTransport;drill?:boolean;relay?:boolean;requireBot?:boolean}={}):Promise<void>{
 if(!Number.isSafeInteger(issue)||issue<1)throw Error('INVALID_MONITOR_ISSUE');
 if(options.relay&&(issue!==52||source!=='operator-mac'))throw Error('INVALID_RELAY_DESTINATION');
 const transport=options.transport??ghTransport,body=alertBody(event,source,options.drill),marker=body.split('\n')[0];
 const path=`/repos/porchday/porchday/issues/${issue}`;
 const target=await transport('GET',path) as {title?:string;pull_request?:unknown};
 if(target.pull_request||target.title!==`External production availability alerts (${source})`)throw Error('MONITOR_ISSUE_MISMATCH');
 // Old events are retained in this dedicated issue; pagination prevents duplicate
 // notifications after a successful write whose acknowledgement was lost.
 for(let page=1;page<=100;page++){
  const comments=await transport('GET',path+`/comments?per_page=100&page=${page}`) as {body?:string;user?:{login?:string;type?:string}}[];
  if(!Array.isArray(comments))throw Error('GITHUB_RESPONSE_INVALID');
  if(comments.some(c=>c.body===body&&(!(options.relay||options.requireBot)||(c.user?.login==='github-actions[bot]'&&c.user.type==='Bot'))))return;
  // A matching marker with a different body is not trusted as delivery proof.
  if(comments.some(c=>c.body?.startsWith(marker)&&c.body!==body))throw Error('MONITOR_EVENT_CONFLICT');
  if(comments.length<100){
   if(options.relay){
    await transport('POST','/repos/porchday/porchday/actions/workflows/external-monitor-relay.yml/dispatches',{
     ref:'main',inputs:{event_id:event.id,payload:JSON.stringify({event:{id:event.id,kind:event.kind,at:event.at,failedChecks:event.failedChecks},drill:!!options.drill})},
    });
    // Dispatch acceptance is not notification delivery. Keep the durable outbox
    // until a later reconciliation observes the exact bot-authored comment.
    throw Error('NOTIFICATION_PENDING');
   }
   await transport('POST',path+'/comments',{body});return;
  }
 }
 throw Error('MONITOR_ISSUE_ROTATION_REQUIRED');
}
