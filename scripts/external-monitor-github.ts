import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {alertBody, type AlertEvent} from './external-monitor-alerts';
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
    try{resolve(JSON.parse(stdout));}catch{reject(Error('GITHUB_RESPONSE_INVALID'));}
   });
   child.stdin?.on('error',()=>{});child.stdin?.end(JSON.stringify(body));
  });
  const result=await exec(process.env.PORCHDAY_MONITOR_GH_PATH??'/opt/homebrew/bin/gh',args,{timeout:15000,maxBuffer:1048576});
  return JSON.parse(result.stdout);
 }catch{throw Error('GITHUB_REQUEST_FAILED');}
};

/** Reconcile an uncertain comment write using its persisted event marker before retrying. */
export async function deliver(issue:number,event:AlertEvent,source:'operator-mac'|'github-backup',options:{transport?:GitHubTransport;drill?:boolean}={}):Promise<void>{
 if(!Number.isSafeInteger(issue)||issue<1)throw Error('INVALID_MONITOR_ISSUE');
 const transport=options.transport??ghTransport,body=alertBody(event,source,options.drill),marker=body.split('\n')[0];
 const path=`/repos/porchday/porchday/issues/${issue}`;
 const target=await transport('GET',path) as {title?:string;pull_request?:unknown};
 if(target.pull_request||target.title!==`External production availability alerts (${source})`)throw Error('MONITOR_ISSUE_MISMATCH');
 // Old events are retained in this dedicated issue; pagination prevents duplicate
 // notifications after a successful write whose acknowledgement was lost.
 for(let page=1;page<=100;page++){
  const comments=await transport('GET',path+`/comments?per_page=100&page=${page}`) as {body?:string}[];
  if(!Array.isArray(comments))throw Error('GITHUB_RESPONSE_INVALID');
  if(comments.some(c=>c.body===body))return;
  // A matching marker with a different body is not trusted as delivery proof.
  if(comments.some(c=>c.body?.startsWith(marker)))throw Error('MONITOR_EVENT_CONFLICT');
  if(comments.length<100){await transport('POST',path+'/comments',{body});return;}
 }
 throw Error('MONITOR_ISSUE_ROTATION_REQUIRED');
}
