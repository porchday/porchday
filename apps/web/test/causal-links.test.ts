import {it,expect} from 'vitest';
import {linkResponse,causeOf,parseClientCause,linkValue} from '../src/causal-links';
it('links decoded values to the actual server span without changing payloads',async()=>{
 const trace='a'.repeat(32),span='b'.repeat(16),response=Response.json({items:[{envelope:{ciphertext:'private'}}]},{headers:{'X-Porchday-Trace':trace,'X-Porchday-Span':span}});
 linkResponse(response,{trace_id:trace,span_id:'c'.repeat(16)});const data=await response.json();expect(causeOf(data.items[0].envelope)).toEqual({trace_id:trace,span_id:span});expect(JSON.stringify(data)).toBe('{"items":[{"envelope":{"ciphertext":"private"}}]}');
});
it('does not create links without explicitly enabled tracing',async()=>{const response=Response.json({a:1});linkResponse(response,undefined);expect(causeOf(await response.json())).toBeUndefined();});
it('bounds traversal and accepts cycles without modifying objects',()=>{const value:any={};value.child=value;linkValue(value,{trace_id:'a'.repeat(32),span_id:'b'.repeat(16)});expect(causeOf(value)).toBeDefined();expect(Object.keys(value)).toEqual(['child']);expect(parseClientCause('00-'+'0'.repeat(32)+'-'+'b'.repeat(16)+'-01')).toBeUndefined();});
it('clears links and rejects delayed response provenance after collection stops',async()=>{
 const {clearClientCauses,causalRequestHeaders,clientParent}=await import('../src/causal-links');
 const cause={trace_id:'d'.repeat(32),span_id:'e'.repeat(16)},value={sealed:{ciphertext:'sealed'}};
 linkValue(value,cause);const headers=new Headers(causalRequestHeaders(value));const request=parseClientCause(headers.get('traceparent'))!;
 expect(request.trace_id).toBe(cause.trace_id);expect(request.span_id).not.toBe(cause.span_id);expect(clientParent(request.span_id)).toBe(cause.span_id);
 const response=Response.json({late:true});linkResponse(response,cause);clearClientCauses();expect(causeOf(value)).toBeUndefined();expect(clientParent(request.span_id)).toBeUndefined();expect(causeOf(await response.json())).toBeUndefined();expect(causalRequestHeaders(value)).toBeUndefined();
});
