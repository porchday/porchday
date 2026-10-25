/** Explicit operator-only DLQ recovery. No message/lease/body is logged. */
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

type Job={kind:'expiry'|'media_backup_start'}|{kind:'media_backup';id:string};
export function decodeJob(message:unknown):{job:Job;lease:string}{
 if(!message||typeof message!=='object')throw Error('QUEUE_MESSAGE_INVALID');
 const item=message as Record<string,any>,type=item.metadata?.['CF-Content-Type'];
 if(typeof item.lease_id!=='string'||!item.lease_id.length||item.lease_id.length>4096||type!=='json'||typeof item.body!=='string'||item.body.length>4096||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.body))throw Error('QUEUE_MESSAGE_INVALID');
 let value:Record<string,unknown>;
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(item.body,'base64')));}catch{throw Error('QUEUE_MESSAGE_INVALID');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('QUEUE_MESSAGE_INVALID');
 const keys=Object.keys(value).sort().join(',');
 if(['expiry','media_backup_start'].includes(String(value.kind))&&keys==='kind')return{job:value as Job,lease:item.lease_id};
 if(value.kind==='media_backup'&&keys==='id,kind'&&typeof value.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id))return{job:value as Job,lease:item.lease_id};
 throw Error('QUEUE_MESSAGE_INVALID');
}
type Call=(path:string,method?:'GET'|'POST',body?:unknown)=>Promise<any>;
export async function replayOne(call:Call,source:string,destination:string):Promise<boolean>{
 // One lease per bounded iteration; do not lease an entire unbounded backlog.
 const result=await call('/queues/'+source+'/messages/pull','POST',{batch_size:1,visibility_timeout_ms:60000});
 if(!Array.isArray(result?.messages)||result.messages.length>1)throw Error('QUEUE_PULL_INVALID');
 if(!result.messages.length)return false;
 const {job,lease}=decodeJob(result.messages[0]);
 // An uncertain publish must leave the original unacknowledged. A crash after
 // accepted publish may duplicate a job; application jobs/outboxes are idempotent.
 await call('/queues/'+destination+'/messages','POST',{body:job,content_type:'json'});
 const ack=await call('/queues/'+source+'/messages/ack','POST',{acks:[{lease_id:lease}],retries:[]});
 if(ack?.ackCount!==1||ack?.retryCount!==0)throw Error('QUEUE_ACK_UNCONFIRMED');
 return true;
}
export function argumentsForReplay(args:string[]){
 if(args.length!==4||!['staging','production'].includes(args[0])||args[1]!=='--replay'||args[2]!=='--limit'||!/^([1-9]|10)$/.test(args[3]))throw Error('USE_ENVIRONMENT_REPLAY_LIMIT_1_TO_10');
 return{environment:args[0],limit:Number(args[3])};
}
async function main(){
 let completed=0;
 try{
  const {environment,limit}=argumentsForReplay(process.argv.slice(2));
  const resources=JSON.parse(await readFile(new URL('../infra/resources.json',import.meta.url),'utf8')),env=resources.environments[environment];
  const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN??process.env.CF_API_TOKEN;
  if(account!==resources.account_id||!/^[a-f0-9]{32}$/.test(account??'')||!token||![env.queue_id,env.dead_letter_queue_id].every(x=>/^[a-f0-9]{32}$/.test(x)))throw Error('QUEUE_CONFIGURATION_INVALID');
  const call:Call=async(path,method='GET',body)=>{
   const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!response.ok){await response.body?.cancel();throw Error('QUEUE_API_UNAVAILABLE');}
   const reader=response.body?.getReader();if(!reader)throw Error('QUEUE_API_INVALID');
   let length=0;const chunks:Uint8Array[]=[];
   try{for(;;){const value=await reader.read();if(value.done)break;length+=value.value.length;if(length>65536){await reader.cancel();throw Error('QUEUE_API_INVALID');}chunks.push(value.value);}}finally{reader.releaseLock();}
   const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(result.success!==true)throw Error('QUEUE_API_UNCONFIRMED');return result.result;
  };
  const source=await call('/queues/'+env.dead_letter_queue_id),destination=await call('/queues/'+env.queue_id);
  if(source.queue_name!==env.dead_letter_queue||destination.queue_name!==env.queue||source.queue_name!==`porchday-${environment}-jobs-dead-letter`||destination.queue_name!==`porchday-${environment}-jobs`)throw Error('QUEUE_IDENTITY_MISMATCH');
  if(!Array.isArray(source.consumers)||source.consumers.length!==1||source.consumers[0].type!=='http_pull'||!Array.isArray(destination.consumers)||!destination.consumers.some((c:any)=>c.type==='worker'&&c.script_name===`porchday-${environment}`))throw Error('QUEUE_CONSUMER_MISMATCH');
  for(let i=0;i<limit;i++){if(!await replayOne(call,env.dead_letter_queue_id,env.queue_id))break;completed++;}
  console.log(JSON.stringify({environment,replayed_and_acknowledged:completed,limit}));
 }catch(error){const code=(error as Error).message;console.error(JSON.stringify({error:/^[A-Z_0-9]{3,80}$/.test(code)?code:'QUEUE_REPLAY_FAILED',replayed_and_acknowledged:completed}));process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main();
