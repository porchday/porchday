import {expect,it} from 'vitest';
import {initialState,type AlertState} from './external-monitor-alerts';
import {parseReview,reviewNotifications,REVIEW_DEADLINE_MS} from './incident-review';
const at='2026-11-23T00:00:00Z',now=Date.parse(at),id='11111111-1111-4111-8111-111111111111';
const pending=():AlertState=>({...initialState(),incident:true,pending:[{id,kind:'outage',at,failedChecks:['login'],incidentId:id,reviewPending:true}]});
const review=(decision:'resolved'|'not_incident'|'notify'|'blocked')=>({incidentId:id,decision,summary:'Sanitized finding with concrete evidence.',evidence:['Retained observation and matching trace.']});
it('holds human delivery until a disposition, including across JSON persistence',()=>{
 const s=reviewNotifications(JSON.parse(JSON.stringify(pending())),()=>({id,phase:'accepted'}),now+60000);expect(s.pending[0].reviewPending).toBe(true);expect(s.ownerIncidents).toEqual([]);
});
it('pages once after an explicit reviewed finding and never re-admits the same incident',()=>{
 const s=reviewNotifications(pending(),()=>({id,phase:'accepted',review:review('notify')}),now+60000);expect(s.pending[0].review).toMatchObject({kind:'reviewed'});expect(s.pending[0].reviewPending).toBe(false);
 expect(reviewNotifications({...s,pending:pending().pending},()=>undefined,now+60000).pending).toEqual([]);
});
it('silences a proven non-incident and its later recovery',()=>{
 let s=reviewNotifications(pending(),()=>({id,phase:'accepted',review:review('not_incident')}),now+60000);expect(s.pending).toEqual([]);
 s=reviewNotifications({...s,pending:[{id:'recovery',incidentId:id,kind:'recovery',at,failedChecks:[],reviewPending:true}]},()=>undefined,now+180000);expect(s.pending).toEqual([]);
});
it('does not accept a claimed fix before observed stable recovery',()=>{
 expect(reviewNotifications(pending(),()=>({id,phase:'accepted',review:review('resolved')}),now+60000).pending[0].reviewPending).toBe(true);
 expect(reviewNotifications(pending(),()=>({id,phase:'accepted',closedAt:at,review:review('resolved')}),now+180000).pending).toEqual([]);
});
it('fails visibly at a bounded deadline even if the responder or its state reader is broken',()=>{
 const s=reviewNotifications(pending(),()=>{throw Error('disk');},now+REVIEW_DEADLINE_MS);expect(s.pending[0].reviewPending).toBe(false);expect(s.pending[0].review?.kind).toBe('fallback');
});
it('keeps legacy pending messages deliverable and rejects mismatched or empty reviews',()=>{
 const s=pending();delete s.pending[0].reviewPending;expect(reviewNotifications(s,()=>undefined,now).pending).toEqual(s.pending);
 expect(()=>parseReview(review('resolved'),'wrong')).toThrow();expect(()=>parseReview({...review('resolved'),evidence:[]},id)).toThrow();
});
