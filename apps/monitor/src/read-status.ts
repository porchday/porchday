/** Only the read-only status request may be retried. Scheduled ticks, alert
 * delivery and storage writes must never pass through this helper. */
export async function readStatus(namespace:DurableObjectNamespace):Promise<Response>{
 const controller=new AbortController();
 let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('MONITOR_STATUS_DEADLINE'));},3000);});
 const read=async()=>{
  for(let attempt=0;attempt<2;attempt++){
   controller.signal.throwIfAborted();
   try{
    // Exceptions can poison a stub. Always acquire a fresh one for the retry.
    const response=await namespace.get(namespace.idFromName('monitor-v1')).fetch('https://monitor.internal/status',{signal:controller.signal});
    // Finish the bounded body before aborting the transport in finally. A
    // returned streaming body would otherwise be canceled on the success path.
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
    const cancel=()=>{void reader?.cancel().catch(()=>{});};
    controller.signal.addEventListener('abort',cancel,{once:true});
    if(reader)try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384)throw Error('MONITOR_STATUS_RESPONSE_TOO_LARGE');chunks.push(part.value);}}
    finally{controller.signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});}
    else controller.signal.removeEventListener('abort',cancel);
    controller.signal.throwIfAborted();
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return new Response(bytes,{status:response.status,headers:response.headers});
   }catch(error){
    const flags=error as {retryable?:unknown;overloaded?:unknown}|null;
    const retryable=flags?.retryable===true,overloaded=flags?.overloaded===true;
    console.log(JSON.stringify({event:'monitor',code:'status_read_failed',attempt:attempt+1,retryable,overloaded}));
    if(controller.signal.aborted||attempt!==0||!retryable||overloaded)throw error;
    await new Promise<void>(resolve=>setTimeout(resolve,100+Math.floor(Math.random()*100)));
   }
  }
  throw Error('MONITOR_STATUS_UNAVAILABLE');
 };
 try{return await Promise.race([read(),deadline]);}
 finally{if(timer)clearTimeout(timer);controller.abort();}
}
