import {isIP} from 'node:net';

/** Retry only name resolution, before constructing any HTTP request. Dispatch
 * is deliberately outside the retry block: an uncertain write is never replayed.
 * Late DNS completion cannot dispatch after either deadline has expired. */
export async function withOperatorAddress<T>(lookup:()=>Promise<string[]>,dispatch:(address:string,remainingMs:number)=>Promise<T>,requestDeadline:number):Promise<T>{
 const dnsDeadline=Math.min(requestDeadline,Date.now()+5000);
 let address:string|undefined;
 for(let attempt=0;attempt<3;attempt++){
  const remaining=dnsDeadline-Date.now();if(remaining<=0)break;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const addresses=await Promise.race([lookup(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('OPERATOR_DNS_NOT_READY')),remaining);})]);
   address=addresses.find(value=>isIP(value)===4);
   if(address&&Date.now()<dnsDeadline)break;
   address=undefined;
  }catch{/* No HTTP request exists; a bounded DNS-only retry is safe. */}
  finally{if(timer!==undefined)clearTimeout(timer);}
  if(attempt<2){const delay=Math.min(100*(attempt+1),dnsDeadline-Date.now());if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));}
 }
 if(!address)throw Error('OPERATOR_DNS_NOT_READY');
 const remaining=requestDeadline-Date.now();if(remaining<=0)throw Error('OPERATOR_PROBE_RUNTIME_EXCEEDED');
 return dispatch(address,remaining);
}
