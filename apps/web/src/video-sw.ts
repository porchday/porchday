/// <reference lib="webworker" />
import {validateVideoManifest,decryptVideoSegment,videoByteRange,VIDEO_CHUNK_BYTES,type VideoManifest} from '@porchday/crypto/video';
const worker=self as unknown as ServiceWorkerGlobalScope;
type Playback={client:string;mediaId:string;manifest:VideoManifest;expires:number;lastUsed:number;abort:AbortController;active:number};
const playbacks=new Map<string,Playback>();
const prefix='/__porchday_video/';
function remove(token:string){playbacks.get(token)?.abort.abort();playbacks.delete(token);}
function clear(client:string){for(const[token,p]of playbacks)if(p.client===client)remove(token);}
worker.addEventListener('message',event=>{
 const source=event.source as Client|null,data=event.data;if(!source?.id||!data||typeof data!=='object')return;
 if(data.type==='VIDEO_CLEAR'){clear(source.id);return;}
 if(data.type==='VIDEO_CLOSE'){if(playbacks.get(data.token)?.client===source.id)remove(data.token);return;}
 if(data.type!=='VIDEO_REGISTER')return;
 try{
  if(new URL(source.url).origin!==worker.location.origin||!/^[-0-9a-f]{36}$/.test(data.token)||!/^[-0-9a-f]{36}$/.test(data.mediaId))throw Error('Invalid playback');
  const manifest=validateVideoManifest(data.manifest),expires=data.expiresAt===null?Infinity:Date.parse(data.expiresAt);
  if(!(expires>Date.now()))throw Error('Expired playback');
  // One active player per tab; registration stops the prior stream immediately.
  if(playbacks.has(data.token)&&playbacks.get(data.token)!.client!==source.id)throw Error('Playback token in use');
  clear(source.id);playbacks.set(data.token,{client:source.id,mediaId:data.mediaId,manifest,expires,lastUsed:Date.now(),abort:new AbortController(),active:0});event.ports[0]?.postMessage({ok:true});
 }catch{event.ports[0]?.postMessage({ok:false});}
});
worker.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);if(url.origin!==worker.location.origin||!url.pathname.startsWith(prefix))return;
 event.respondWith(play(event,url.pathname.slice(prefix.length).replace(/\.mp4$/,'')));
});
async function play(event:FetchEvent,token:string):Promise<Response>{
 const p=playbacks.get(token);if(!p||event.clientId!==p.client||p.expires<=Date.now()||p.abort.signal.aborted||!['GET','HEAD'].includes(event.request.method)){if(p&&p.expires<=Date.now())remove(token);return new Response(null,{status:403,headers:{'Cache-Control':'no-store'}});}
 if(!await worker.clients.get(p.client)){remove(token);return new Response(null,{status:410});}
 const range=videoByteRange(event.request.headers.get('Range'),p.manifest.size);if(!range)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${p.manifest.size}`,'Cache-Control':'no-store'}});
 const headers=new Headers({'Content-Type':'video/mp4','Cache-Control':'private, no-store','Accept-Ranges':'bytes','Content-Length':String(range.end-range.start+1),'X-Content-Type-Options':'nosniff'});if(range.partial)headers.set('Content-Range',`bytes ${range.start}-${range.end}/${p.manifest.size}`);
 if(event.request.method==='HEAD')return new Response(null,{status:range.partial?206:200,headers});
 if(p.active>=2)return new Response(null,{status:429,headers:{'Retry-After':'1','Cache-Control':'no-store'}});
 p.active++;p.lastUsed=Date.now();let offset=range.start,cachedIndex=-1,cached:Uint8Array|undefined,closed=false;
 const requestAbort=new AbortController();const stop=()=>requestAbort.abort();p.abort.signal.addEventListener('abort',stop,{once:true});event.request.signal.addEventListener('abort',stop,{once:true});
 function finish(){if(closed)return;closed=true;p!.active--;cached=undefined;p!.abort.signal.removeEventListener('abort',stop);event.request.signal.removeEventListener('abort',stop);requestAbort.abort();}
 const stream=new ReadableStream<Uint8Array>({async pull(controller){
  try{
   if(closed)return;if(p.expires<=Date.now()||p.abort.signal.aborted||requestAbort.signal.aborted)throw Error('Video access ended');
   if(offset>range.end){finish();controller.close();return;}
   const index=Math.floor(offset/VIDEO_CHUNK_BYTES);
   if(index!==cachedIndex){
    const response=await fetch(`/api/v1/videos/${encodeURIComponent(p.mediaId)}/chunks/${index}`,{credentials:'same-origin',cache:'no-store',signal:requestAbort.signal});
    if(!response.ok){remove(token);throw Error('Video is no longer available');}
    const expected=p.manifest.segments[index].size;const length=response.headers.get('Content-Length');if(length&&Number(length)!==expected)throw Error('Invalid video size');
    const reader=response.body!.getReader(),bytes=new Uint8Array(expected);let count=0;
    try{for(;;){const item=await reader.read();if(item.done)break;if(count+item.value.length>expected)throw Error('Invalid video size');bytes.set(item.value,count);count+=item.value.length;}if(count!==expected)throw Error('Incomplete video');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    cached=await decryptVideoSegment(p.manifest,index,bytes);cachedIndex=index;
   }
   if(requestAbort.signal.aborted||p.expires<=Date.now())throw Error('Video access ended');
   const local=offset-index*VIDEO_CHUNK_BYTES,count=Math.min(64*1024,cached!.length-local,range.end-offset+1);controller.enqueue(cached!.slice(local,local+count));offset+=count;p.lastUsed=Date.now();
  }catch(error){finish();controller.error(error);}
 },cancel(){finish();}},{highWaterMark:0});
 return new Response(stream,{status:range.partial?206:200,headers});
}
// No bytes, keys or registrations enter CacheStorage or IndexedDB. Idle records
// are discarded opportunistically even when a tab vanished without cleanup.
worker.addEventListener('message',()=>{for(const[token,p]of playbacks)if(p.expires<=Date.now()||Date.now()-p.lastUsed>30*60*1000)remove(token);});
