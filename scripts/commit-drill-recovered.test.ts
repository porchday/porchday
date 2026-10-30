import {it,expect} from 'vitest';
import {observeRecoveredDrill} from './commit-drill-recovered';

it('bounds a stalled read and never proceeds to SQL or a write',async()=>{
 let reads=0,writes=0;
 const options={store:{get:async()=>{reads++;return new Promise<never>(()=>{});},put:async()=>{writes++;throw Error('unexpected write');}},sql:undefined,fixture:{},expected:{operationId:'test'},pendingAtKill:[]};
 await expect(observeRecoveredDrill(options as never,AbortSignal.timeout(20))).rejects.toThrow('DRILL_RECOVERY_DEADLINE');
 expect(reads).toBe(1);expect(writes).toBe(0);
});
it('does not read after caller cancellation',async()=>{
 let reads=0;
 const options={store:{get:async()=>{reads++;throw Error('unexpected read');}},fixture:{},expected:{},pendingAtKill:[]};
 await expect(observeRecoveredDrill(options as never,AbortSignal.abort())).rejects.toThrow();
 expect(reads).toBe(0);
});
