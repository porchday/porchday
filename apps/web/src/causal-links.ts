/** Explicit causal links travel with in-memory values, never in encrypted
 * content or persistent member records. No global async 'current operation'. */
export type ClientCause={trace_id:string;span_id:string};
let causes=new WeakMap<object,ClientCause>(),epoch=0;const parents=new Map<string,string>();const wrapped=new WeakSet<Response>();
export function clearClientCauses(){causes=new WeakMap();parents.clear();epoch++;}
export function parseClientCause(header:string|null):ClientCause|undefined{
 const m=/^00-([a-f0-9]{32})-([a-f0-9]{16})-0[01]$/.exec(header??'');return m&&!/^0+$/.test(m[1])&&!/^0+$/.test(m[2])?{trace_id:m[1],span_id:m[2]}:undefined;
}
export function clientSpanId(){return crypto.randomUUID().replaceAll('-','').slice(0,16);}
export function causeOf(value:unknown):ClientCause|undefined{return value&&typeof value==='object'?causes.get(value):undefined;}
export function linkValue(value:unknown,cause:ClientCause){
 const pending=[value],seen=new Set<object>();let budget=3000;
 while(pending.length&&budget-->0){const item=pending.pop();if(!item||typeof item!=='object'||seen.has(item))continue;seen.add(item);causes.set(item,cause);
  if(Array.isArray(item))pending.push(...item.slice(0,3000));else if(Object.getPrototypeOf(item)===Object.prototype)pending.push(...Object.values(item));
 }
}
export function linkResponse(response:Response,requestCause:ClientCause|undefined){
 if(!requestCause||wrapped.has(response))return;wrapped.add(response);
 const trace=response.headers.get('X-Porchday-Trace'),span=response.headers.get('X-Porchday-Span');
 const cause=trace&&span?parseClientCause(`00-${trace}-${span}-01`)??requestCause:requestCause;
 const captured=epoch,json=response.json.bind(response);response.json=async()=>{const value=await json();if(captured===epoch)linkValue(value,cause);return value;};
}

export function causalRequestHeaders(value:unknown):HeadersInit|undefined{
 const cause=causeOf(value)??(value&&typeof value==='object'?Object.values(value).slice(0,30).map(causeOf).find(Boolean):undefined);
 if(!cause)return;const networkSpan=clientSpanId();if(parents.size>=1000)parents.delete(parents.keys().next().value!);parents.set(networkSpan,cause.span_id);return {traceparent:`00-${cause.trace_id}-${networkSpan}-01`};
}

export function clientParent(span:string|undefined){return span?parents.get(span):undefined;}
