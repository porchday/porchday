import {afterEach,expect,it,vi} from 'vitest';
import {logoutJournalTiming,measureJournalPhase} from '../src/journal-timing';
import {event} from '../src/telemetry';
import type {Env} from '../src/types';
afterEach(()=>vi.restoreAllMocks());
it('requires explicit hosted logout opt-in and ignores all other request classes',()=>{
 const base={ENVIRONMENT:'production',LOGOUT_PHASE_TIMING:'true'} as Env;
 expect(logoutJournalTiming(base,{method:'POST',path:'/api/auth/sign-out'})).toBeDefined();
 for(const request of [undefined,{method:'GET',path:'/api/auth/sign-out'},{method:'POST',path:'/api/auth/sign-out?token=private'},{method:'POST',path:'/api/auth/sign-in/email'}])expect(logoutJournalTiming(base,request)).toBeUndefined();
 for(const setting of [undefined,'false','TRUE'])expect(logoutJournalTiming({...base,LOGOUT_PHASE_TIMING:setting},{method:'POST',path:'/api/auth/sign-out'})).toBeUndefined();
 expect(logoutJournalTiming({...base,ENVIRONMENT:'development'},{method:'POST',path:'/api/auth/sign-out'})).toBeUndefined();
});
it('reports elapsed time on success and original rejection, invoking each operation once',async()=>{
 const record=vi.fn(),work=vi.fn(async()=>42);
 vi.spyOn(performance,'now').mockReturnValueOnce(10).mockReturnValueOnce(35).mockReturnValueOnce(40).mockReturnValueOnce(50);
 expect(await measureJournalPhase({record},'work',work)).toBe(42);expect(work).toHaveBeenCalledTimes(1);
 const failure=Error('private payload'),failed=vi.fn(async()=>{throw failure;});
 await expect(measureJournalPhase({record},'receipt',failed)).rejects.toBe(failure);expect(failed).toHaveBeenCalledTimes(1);
 expect(record.mock.calls).toEqual([['work',25],['receipt',10]]);
});
it('failed clocks and observers cannot change work outcomes',async()=>{
 const failure=Error('private original');
 const timing={record(){throw Error('observer');}};
 await expect(measureJournalPhase(timing,'work',async()=>{throw failure;})).rejects.toBe(failure);
 vi.spyOn(performance,'now').mockImplementation(()=>{throw Error('clock');});
 await expect(measureJournalPhase(timing,'work',async()=>42)).resolves.toBe(42);
});
it('defends the telemetry boundary against arbitrary phase data and unavailable sinks',async()=>{
 const writeDataPoint=vi.fn();const env={ENVIRONMENT:'production',LOGOUT_PHASE_TIMING:'true',METRICS:{writeDataPoint}} as unknown as Env;
 const fields={route:'/api/auth/sign-out',method:'POST',code:'work',durationMs:17.5,status:500,count:50,detailMs:22,member:'private',token:'secret'};
 event('journal_phase',fields,env);
 expect(writeDataPoint.mock.calls[0][0]).toEqual({indexes:['journal_phase:/api/auth/sign-out'],blobs:['porchday_metrics_v1','production','journal_phase','/api/auth/sign-out','POST','work','none'],doubles:[0,18,0]});
 for(const change of [{code:'secret'}, {route:'/api/private/member'}, {durationMs:NaN},{durationMs:-1},{durationMs:Infinity},{durationMs:3600001}])event('journal_phase',{...fields,...change},env);
 event('journal_phase',fields,{...env,LOGOUT_PHASE_TIMING:undefined});expect(writeDataPoint).toHaveBeenCalledTimes(1);
 env.METRICS={writeDataPoint:()=>Promise.reject(Error('private transport'))} as never;
 await expect(measureJournalPhase(logoutJournalTiming(env,{method:'POST',path:'/api/auth/sign-out'}),'work',async()=>42)).resolves.toBe(42);
});
