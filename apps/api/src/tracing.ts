import {AsyncLocalStorage} from 'node:async_hooks';
import type {MiddlewareHandler} from 'hono';
import {routePath} from 'hono/route';
import type {Env,Variables} from './types';

/** Opt-in, first-party performance tracing. A browser that the member has
 * opted in sends a W3C `traceparent` header. The Worker then keeps
 * request-local spans and returns them to that member's own browser in
 * `Server-Timing`, so ordinary requests never write trace storage. The browser
 * batches its spans (with these server spans nested inside each fetch) into a
 * single upload. See docs/performance-tracing.md.
 */
const TRACEPARENT=/^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;
const MAX_SPANS=60;
type Span={name:string;start:number;duration:number};
export class RequestTrace {
 readonly origin=performance.now();
 readonly spans:Span[]=[];
 readonly counts=new Map<string,number>();
 error?:string;
 constructor(readonly traceId:string){}
 span(name:string,start:number,duration:number):void {
  if(this.spans.length>=MAX_SPANS||!Number.isFinite(start)||!Number.isFinite(duration)||duration<0)return;
  this.spans.push({name,start:Math.max(0,start-this.origin),duration});
 }
 count(name:string,amount=1):void {this.counts.set(name,(this.counts.get(name)??0)+amount);}
 header(extra:{edge?:string;release?:string;route?:string;total:number}):string {
  const entries=['pd-trace;desc='+quote(this.traceId),'pd-total;dur='+round(extra.total)];
  if(extra.edge)entries.push('pd-edge;desc='+quote(extra.edge));
  if(extra.release)entries.push('pd-release;desc='+quote(extra.release.slice(0,8)));
  if(extra.route)entries.push('pd-route;desc='+quote(extra.route));
  for(const span of this.spans)entries.push('pd-span;dur='+round(span.duration)+';desc='+quote(span.name+'@'+round(span.start)));
  for(const [name,value] of this.counts)entries.push('pd-count;desc='+quote(name+'='+value));
  if(this.error)entries.push('pd-error;desc='+quote(this.error));
  return entries.join(', ');
 }
}
const store=new AsyncLocalStorage<RequestTrace>();
export function activeTrace():RequestTrace|undefined {return store.getStore();}
export function traceIdFrom(header:string|undefined):string|undefined {
 const match=header?TRACEPARENT.exec(header):null;
 return match&&!/^0+$/.test(match[1])&&!/^0+$/.test(match[2])?match[1]:undefined;
}
/** Record a span that ended now. Diagnostics never affect the operation. */
export function recordTraceSpan(name:string,durationMs:number):void {
 try{const trace=store.getStore();trace?.span(name,performance.now()-durationMs,durationMs);}catch{}
}
export function countTrace(name:string,amount=1):void {try{store.getStore()?.count(name,amount);}catch{}}
export async function traceSpan<T>(name:string,work:()=>Promise<T>):Promise<T> {
 const trace=store.getStore();
 if(!trace)return work();
 const start=performance.now();
 try{return await work();}
 finally{trace.span(name,start,performance.now()-start);}
}

/** Error class, application code and Postgres SQLSTATE, plus a short message
 * with email addresses and long opaque tokens removed. Never a stack trace. */
export function describeError(error:unknown):string {
 const e=(error??{}) as {name?:unknown;code?:unknown;message?:unknown};
 const parts:string[]=[];
 const name=typeof e.name==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(e.name)?e.name:'Error';
 parts.push('class='+name);
 if(typeof e.code==='string'&&/^[0-9A-Z]{5}$/.test(e.code))parts.push('sqlstate='+e.code);
 else if(typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{2,47}$/.test(e.code))parts.push('code='+e.code);
 if(typeof e.message==='string'&&e.message)parts.push('msg='+scrubMessage(e.message));
 return parts.join(' ');
}
export function scrubMessage(message:string):string {
 return message
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,'[email]')
  .replace(/[A-Za-z0-9+/_=-]{24,}/g,'[token]')
  .replace(/\s+/g,' ').trim().slice(0,200);
}
function quote(value:string):string {
 // Server-Timing descriptions are quoted strings: printable ASCII only.
 return '"'+value.replace(/[^\x20-\x7e]/g,'?').replace(/["\\]/g,"'")+'"';
}
function round(value:number):number {return Math.round(value*10)/10;}

export function tracingMiddleware():MiddlewareHandler<{Bindings:Env;Variables:Variables}> {
 return async(c,next)=>{
  const traceId=traceIdFrom(c.req.header('traceparent'));
  if(!traceId)return next();
  const trace=new RequestTrace(traceId);
  await store.run(trace,()=>next());
  // Only a signed-in member's own browser receives internal phase timings,
  // matching the existing rule that anonymous callers see no phase detail.
  if(!c.get('memberId'))return;
  try{
   const cf=(c.req.raw as {cf?:{colo?:unknown}}).cf,route=routePath(c);
   c.header('Server-Timing',trace.header({
    total:performance.now()-trace.origin,
    edge:typeof cf?.colo==='string'?cf.colo:undefined,
    release:c.env.CF_VERSION_METADATA?.id,
    // The responding handler's registered pattern, e.g. /api/v1/media/:id/bytes.
    route:route&&!['*','/*'].includes(route)?route:undefined,
   }),{append:true});
  }catch{/* Diagnostics are optional. */}
 };
}
/** Called from app.onError so a traced 503 still explains itself. */
export function traceError(error:unknown):void {try{const trace=store.getStore();if(trace&&!trace.error)trace.error=describeError(error);}catch{}}
