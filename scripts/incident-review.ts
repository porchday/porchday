import type {AlertEvent,AlertState} from './external-monitor-alerts.ts';
export const REVIEW_DEADLINE_MS=15*60000;
export type IncidentReview={incidentId:string;decision:'resolved'|'not_incident'|'notify'|'blocked';summary:string;evidence:string[]};
export const reviewSchema={type:'object',additionalProperties:false,required:['incidentId','decision','summary','evidence'],properties:{incidentId:{type:'string'},decision:{type:'string',enum:['resolved','not_incident','notify','blocked']},summary:{type:'string'},evidence:{type:'array',items:{type:'string'}}}};
export function parseReview(value:unknown,id:string):IncidentReview{
 const r=value as IncidentReview;
 if(!r||r.incidentId!==id||!['resolved','not_incident','notify','blocked'].includes(r.decision)||typeof r.summary!=='string'||!r.summary.trim()||r.summary.length>1200||!Array.isArray(r.evidence)||!r.evidence.length||r.evidence.length>12||r.evidence.some(v=>typeof v!=='string'||!v.trim()||v.length>500))throw Error('INCIDENT_REVIEW_INVALID');
 return {incidentId:r.incidentId,decision:r.decision,summary:r.summary.replace(/\s+/g,' ').trim(),evidence:r.evidence};
}
export type ReviewRecord={id:string;closedAt?:string;review?:IncidentReview;phase:string;error?:string};
/** A durable outbox is held while the responder works. Legacy queued events
 * retain their original delivery semantics. Recovery only follows an owner page. */
export function reviewNotifications(state:AlertState,read:(id:string)=>ReviewRecord|undefined,now:number):AlertState{
 const owners=new Set(state.ownerIncidents??[]),silent=new Set(state.silentIncidents??[]),pending:AlertEvent[]=[];
 for(const event of state.pending){
  if(!event.reviewPending){pending.push(event);continue;}
  const id=event.incidentId??event.id;
  if(event.kind==='recovery'){
   if(silent.has(id))continue;
   if(owners.has(id))pending.push({...event,reviewPending:false});
   else if(!silent.has(id))pending.push(event);
   continue;
  }
  if(owners.has(id)||silent.has(id))continue;
  let incident:ReviewRecord|undefined;try{incident=read(id);}catch{/* A broken reader cannot silence an incident indefinitely. */}
  let review:IncidentReview|undefined;try{if(incident?.review)review=parseReview(incident.review,id);}catch{/* Invalid or stale receipts are never authorization to silence. */}
  if(review&&(review.decision==='not_incident'||review.decision==='resolved'&&(incident?.closedAt||!state.incident&&state.healthySince&&now-Date.parse(state.healthySince)>=140000))){
   silent.add(id);continue;
  }
  if(review&&['notify','blocked'].includes(review.decision)){
   owners.add(id);pending.push({...event,reviewPending:false,review:{kind:'reviewed',summary:review.summary}});continue;
  }
  if(now-Date.parse(event.at)>=REVIEW_DEADLINE_MS){
   owners.add(id);if(incident?.closedAt)silent.add(id);pending.push({...event,reviewPending:false,review:{kind:'fallback',summary:incident?.review?.decision==='resolved'?'The responder reported a fix, but stable recovery has not been verified.':'Automated investigation has not produced a verified disposition within 15 minutes. Inspect the incident responder; application downtime is not established by this timeout.'}});continue;
  }
  pending.push(event);
 }
 return {...state,pending,ownerIncidents:[...owners].slice(-128),silentIncidents:[...silent].slice(-128)};
}
