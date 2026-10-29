import {expect,test,vi} from 'vitest';
import {observeCapacityStage,CapacityObservationError,type CapacityObservationEvent} from './session-denial-capacity-observation';

test('awaits durable start and private retention before returning, without logging results',async()=>{
 const events:CapacityObservationEvent[]=[],order:string[]=[];
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const work=vi.fn(async()=>{order.push('work');return {privateValue:'secret-session'};});
 const result=observeCapacityStage({sample:0,stage:'probe',record:async e=>{events.push(e);if(e.state==='started')await gate;order.push(e.state);}},work,async()=>{order.push('retain');});
 await Promise.resolve();expect(work).not.toHaveBeenCalled();release();
 expect(await result).toEqual({privateValue:'secret-session'});
 expect(order).toEqual(['started','work','retain','retained']);expect(JSON.stringify(events)).not.toContain('secret-session');
});

test.each(['probe','health','fixture_count','exact_progress'] as const)('retains fixed %s failure metadata and never retries',async stage=>{
 const events:CapacityObservationEvent[]=[],retain=vi.fn();
 const work=vi.fn(async()=>{throw Object.assign(new Error('credential=value'),{name:'TimeoutError',cause:{token:'private'}});});
 const error=await observeCapacityStage({sample:25,stage,record:e=>{events.push(e);}},work,retain).catch(e=>e);
 expect(error).toBeInstanceOf(CapacityObservationError);expect(error).toMatchObject({stage,failureAt:'operation',errorKind:'TimeoutError',failureRecordWritten:true});
 expect(work).toHaveBeenCalledTimes(1);expect(retain).not.toHaveBeenCalled();
 expect(events).toEqual([{v:1,sample:25,stage,state:'started'},{v:1,sample:25,stage,state:'failed',failureAt:'operation',errorKind:'TimeoutError'}]);
 expect(JSON.stringify({error,events})).not.toMatch(/credential|private|token/);
});

test('start evidence failure prevents the operation, including asynchronous sink failure',async()=>{
 const work=vi.fn();const record=vi.fn(async()=>{throw Error('disk full /private/path');});
 await expect(observeCapacityStage({sample:0,stage:'probe',record},work,vi.fn())).rejects.toMatchObject({failureAt:'start_record',failureRecordWritten:false});
 expect(work).not.toHaveBeenCalled();expect(record).toHaveBeenCalledTimes(1);
});

test('retention failure remains distinct and cannot turn a completed operation into a retried operation',async()=>{
 const work=vi.fn(async()=>42),events:CapacityObservationEvent[]=[];
 await expect(observeCapacityStage({sample:0,stage:'fixture_count',record:e=>{events.push(e);}},work,async()=>{throw Error('disk full');})).rejects.toMatchObject({failureAt:'retention',errorKind:'Error',failureRecordWritten:true});
 expect(work).toHaveBeenCalledTimes(1);expect(events.at(-1)?.state).toBe('failed');expect(events.some(e=>e.state==='retained')).toBe(false);
});

test('unknown error names/getters and unavailable failure sinks do not leak or mask the fixed failure',async()=>{
 const record=vi.fn(async(e:CapacityObservationEvent)=>{if(e.state==='failed')throw Error('private sink error');});
 const hostile={get name(){throw Error('private getter');}};
 const error=await observeCapacityStage({sample:0,stage:'exact_progress',record},async()=>{throw hostile;},vi.fn()).catch(e=>e);
 expect(error).toMatchObject({failureAt:'operation',errorKind:'OtherError',failureRecordWritten:false});
 expect(JSON.stringify(error)).not.toContain('private');expect(record).toHaveBeenCalledTimes(2);
});

test('invalid stage/sample cannot write evidence or dispatch work',async()=>{
 const record=vi.fn(),work=vi.fn();
 for(const sample of [-1,0.5,10001,NaN])await expect(observeCapacityStage({sample,stage:'probe',record},work,vi.fn())).rejects.toThrow('CAPACITY_OBSERVATION_SCOPE');
 await expect(observeCapacityStage({sample:0,stage:'private-token' as 'probe',record},work,vi.fn())).rejects.toThrow('CAPACITY_OBSERVATION_SCOPE');
 expect(record).not.toHaveBeenCalled();expect(work).not.toHaveBeenCalled();
});
