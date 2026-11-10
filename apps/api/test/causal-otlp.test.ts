import {it,expect} from 'vitest';
import {causalOtlp} from '../../../scripts/causal-otlp';
import type {CausalRecord} from '../src/causal-tracing';
it('exports unfinished observations as events without inventing completion',()=>{
 const record={traceId:'a'.repeat(32),rootId:'b'.repeat(16),service:'api',environment:'staging',release:'test',kind:'http',route:'/api/v1/feed',started:1000,duration:100,responseDuration:50,status:503,reason:'error',droppedSpans:0,droppedLinks:2,links:[],spans:[{id:'c'.repeat(16),parent:'b'.repeat(16),name:'r2.get',start:5,outcome:'pending'},{id:'d'.repeat(16),parent:'b'.repeat(16),name:'db.social.query',start:10,duration:20,outcome:'error',code:'53300'}]} as CausalRecord;
 const spans=causalOtlp([record]).resourceSpans[0].scopeSpans[0].spans;
 expect(spans).toHaveLength(2);expect(spans.every(s=>!!s.endTimeUnixNano)).toBe(true);expect(spans[0].events).toHaveLength(1);expect(spans[0].events?.[0].name).toBe('porchday.unfinished');expect(spans[1].status.code).toBe(2);expect(spans[1].endTimeUnixNano).toBe('1030000000');
});
