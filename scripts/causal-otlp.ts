import type {CausalRecord} from '../apps/api/src/causal-tracing.ts';
const nano=(ms:number)=>String(BigInt(Math.round(ms*1000))*1000n);
const attribute=(key:string,value:string|number)=>({key,value:typeof value==='number'?{doubleValue:value}:{stringValue:value}});
/** OTLP exports completed spans only. Unfinished observations are root events,
 * not spans with invented end times or successful outcomes. */
export function causalOtlp(records:CausalRecord[]){
 return {resourceSpans:records.map(r=>({resource:{attributes:[attribute('service.name','porchday-'+r.service),attribute('deployment.environment.name',r.environment),attribute('service.version',r.release)]},scopeSpans:[{scope:{name:'porchday.causal',version:'1'},spans:[{
  traceId:r.traceId,spanId:r.rootId,...(r.parentId?{parentSpanId:r.parentId}:{}),name:r.kind+' '+r.route,startTimeUnixNano:nano(r.started),endTimeUnixNano:nano(r.started+r.duration),status:{code:r.reason==='error'?2:1},
  attributes:[attribute('http.response.status_code',r.status),attribute('porchday.sampling.reason',r.reason),attribute('porchday.dropped_spans',r.droppedSpans),attribute('porchday.dropped_links',r.droppedLinks??0),attribute('porchday.response.duration_ms',r.responseDuration)],
  links:r.links.map(l=>({traceId:l.traceId,spanId:l.spanId})),
  events:r.spans.filter(s=>s.duration===undefined).map(s=>({name:'porchday.unfinished',timeUnixNano:nano(r.started+s.start),attributes:[attribute('porchday.span.id',s.id),attribute('porchday.span.parent',s.parent),attribute('porchday.span.name',s.name)]})),
 },...r.spans.filter(s=>s.duration!==undefined).map(s=>({traceId:r.traceId,spanId:s.id,parentSpanId:s.parent,name:s.name,startTimeUnixNano:nano(r.started+s.start),endTimeUnixNano:nano(r.started+s.start+s.duration!),status:{code:s.outcome==='error'?2:s.outcome==='cancelled'?0:1},attributes:[attribute('porchday.outcome',s.outcome),...(s.code?[attribute('error.type',s.code)]:[]),...(s.quantity!==undefined?[attribute('porchday.quantity',s.quantity)]:[])]}))]}]}))};
}
