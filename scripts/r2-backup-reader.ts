/** Read-only operator transport. It does not depend on REST conditional writes. */
export function backupReaderFromEnvironment(bucket:string){
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN??process.env.CF_API_TOKEN;
 if(!account||!token||!/^porchday-(staging|production)-media-backup$/.test(bucket))throw Error('BACKUP_READER_CONFIGURATION_INVALID');
 return {async get(key:string){
  if(!/^snapshots\/[a-f0-9-]{36}\/(complete\.json|pages\/[0-9]{8}-[a-f0-9]{64}\.json|objects\/[a-f0-9-]{36}\/[a-f0-9-]{36})$/.test(key))throw Error('BACKUP_READER_KEY_INVALID');
  let response:Response;try{response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/r2/buckets/'+bucket+'/objects/'+key,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw Error('BACKUP_READER_UNAVAILABLE');}
  if(response.status===404)return null;if(!response.ok||!response.body)throw Error('BACKUP_READER_FAILED');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>22020096){await reader.cancel();throw Error('BACKUP_OBJECT_TOO_LARGE');}chunks.push(value);}
  const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  return {size,text:async()=>new TextDecoder('utf-8',{fatal:true}).decode(data),arrayBuffer:async()=>data.buffer};
 }};
}
