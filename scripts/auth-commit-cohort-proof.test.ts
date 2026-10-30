import {it,expect,vi} from 'vitest';
import {proveAuthCommitCohort,type AuthCommitRequestWindow} from './auth-commit-cohort-proof';
import {sha256} from '../apps/api/src/privacy-journal';

async function fixture(count=2,times?:number[]){
 const now=Date.now(),generation=crypto.randomUUID(),rows=new Map<string,string>();
 const requests:AuthCommitRequestWindow[]=Array.from({length:count},()=>({memberId:crypto.randomUUID(),sessionId:crypto.randomUUID(),startedAt:now-4000,endedAt:now-1000,status:200,deniedStatus:401}));
 const fences=[];
 for(let i=0;i<count;i++){
  const id=crypto.randomUUID(),started_at=new Date(times?.[i]??now-3000).toISOString(),original=JSON.stringify({v:1,id,started_at});rows.set(`intents/${id}.json`,original);
  const raw=JSON.stringify({v:1,id,started_at,generation,transaction:'single-auth-transaction',intent_sha256:await sha256(original),baseline:{sequence:'0',head:null}});rows.set(`commit-scopes/v1/${id}.json`,raw);
  const scope_sha256=await sha256(raw);fences.push({operation_id:id,scope_sha256,generation,sequence:String(i+1),decision:{kind:'privacy_operation_committed',operation_id:id,scope_sha256}});
 }
 const batch={v:1,generation,from:'1',to:String(count),previous:null,events:fences.map(f=>({sequence:f.sequence,id:crypto.randomUUID(),occurred_at:new Date(now-2000).toISOString(),decision:f.decision}))};
 const raw=JSON.stringify(batch),hash=await sha256(raw),key=`batches/${generation}/1-${count}-${hash}.json`;rows.set(key,raw);
 const control={v:1,generation,mode:'active',sequence:String(count),head:{key,hash},pending:[],reason:null};rows.set('control.json',JSON.stringify(control));
 for(const f of fences)rows.set(`receipts/${f.operation_id}.json`,JSON.stringify({v:1,id:f.operation_id,generation,sequence:String(count),head:control.head}));
 const state={status:{generation,sequence:String(count),quarantined:false},sessions:'0',users:String(count)};
 const db={query:vi.fn(async(text:string,values?:unknown[])=>{
  expect(text.startsWith('SELECT ')).toBe(true);
  if(text.includes('LIMIT 5')){expect(values).toHaveLength(1);expect(typeof values![0]).toBe('string');return{rows:fences};}
  expect(values).toEqual([requests.map(r=>r.sessionId),requests.map(r=>r.memberId)]);return{rows:[state]};
 })};
 const store={get:vi.fn(async(key:string)=>rows.has(key)?{etag:'synthetic',text:async()=>rows.get(key)!}:null),put:vi.fn(async()=>{throw Error('unexpected write');})};
 return{now,rows,fences,control,state,options:{db,store,baselineSequence:'0',generation,requests,assertScope:vi.fn()}};
}
it.each([2,4])('proves %i canonical commits as a cohort without claiming member identity',async count=>{
 const f=await fixture(count),before=new Map(f.rows),result=await proveAuthCommitCohort(f.options,new AbortController().signal);
 expect(result).toMatchObject({passed:true,count,windowMatching:'ambiguous-by-time',perRequestIdentityProved:false,canonicalMarkersAndReceipts:true,providerWrites:0,databaseWrites:0});
 expect(result.commits).toHaveLength(count);expect(f.rows).toEqual(before);expect(f.options.store.put).not.toHaveBeenCalled();expect(f.options.db.query).toHaveBeenCalledTimes(2);
});
it('reports unique time matching without upgrading it to identity proof',async()=>{
 const now=Date.now(),f=await fixture(2,[now-3500,now-1500]);
 f.options.requests[0].endedAt=now-2000;f.options.requests[1].startedAt=now-2500;
 expect(await proveAuthCommitCohort(f.options,new AbortController().signal)).toMatchObject({windowMatching:'unique-by-time',perRequestIdentityProved:false});
});
it('requires a window bijection even when every intent falls in the union',async()=>{
 const f=await fixture();f.options.requests[0].endedAt=f.now-2000;f.options.requests[1].startedAt=f.now-2500;
 await expect(proveAuthCommitCohort(f.options,new AbortController().signal)).rejects.toThrow('AUTH_COHORT_PROOF_UNVERIFIED');
});
it.each(['missing-receipt','orphan-marker','bad-scope','pending','quarantine','session-remains','account-missing','wrong-generation','sql-behind','duplicate-operation','duplicate-sequence','extra-fence','missing-fence','wrong-marker','stale-marker'])('rejects incomplete or inconsistent evidence: %s',async kind=>{
 const f=await fixture(),first=f.fences[0];
 if(kind==='missing-receipt')f.rows.delete(`receipts/${first.operation_id}.json`);
 if(kind==='orphan-marker')f.rows.delete(f.control.head.key);
 if(kind==='bad-scope')f.rows.set(`commit-scopes/v1/${first.operation_id}.json`,'{}');
 if(kind==='pending')f.rows.set('control.json',JSON.stringify({...f.control,pending:[{id:first.operation_id,started_at:new Date(f.now-3000).toISOString()}]}));
 if(kind==='quarantine')f.state.status.quarantined=true;
 if(kind==='session-remains')f.state.sessions='1';
 if(kind==='account-missing')f.state.users='1';
 if(kind==='wrong-generation')f.options.generation=crypto.randomUUID();
 if(kind==='sql-behind')f.state.status.sequence='0';
 if(kind==='duplicate-operation')f.fences[1].operation_id=first.operation_id;
 if(kind==='duplicate-sequence')f.fences[1].sequence=first.sequence;
 if(kind==='extra-fence')f.fences.push({...first,operation_id:crypto.randomUUID(),sequence:'3'});
 if(kind==='missing-fence')f.fences.pop();
 if(kind==='wrong-marker')first.decision.scope_sha256='0'.repeat(64);
 if(kind==='stale-marker')f.options.baselineSequence='2';
 await expect(proveAuthCommitCohort(f.options,new AbortController().signal)).rejects.toThrow('AUTH_COHORT_PROOF_UNVERIFIED');expect(f.options.store.put).not.toHaveBeenCalled();
});
it.each(['too-few','too-many','duplicate-member','duplicate-session','failed-request','accepted-cookie','no-overlap','over-budget','future','bad-baseline'])('rejects request admission before I/O: %s',async kind=>{
 const f=await fixture(),r=f.options.requests;
 if(kind==='too-few')r.pop();if(kind==='too-many')r.push(...r,...r);
 if(kind==='duplicate-member')r[1].memberId=r[0].memberId;if(kind==='duplicate-session')r[1].sessionId=r[0].sessionId;
 if(kind==='failed-request')(r[0] as any).status=503;if(kind==='accepted-cookie')(r[0] as any).deniedStatus=200;
 if(kind==='no-overlap')r[1].startedAt=r[0].endedAt;
 if(kind==='over-budget')r[0].startedAt-=10000;if(kind==='future')r[0].endedAt=Date.now()+100000;
 if(kind==='bad-baseline')f.options.baselineSequence='-1';
 await expect(proveAuthCommitCohort(f.options,new AbortController().signal)).rejects.toThrow('AUTH_COHORT_PROOF_UNVERIFIED');expect(f.options.db.query).not.toHaveBeenCalled();expect(f.options.store.get).not.toHaveBeenCalled();
});
it.each(['sql','store','scope'])('sanitizes %s failure and never writes',async kind=>{
 const f=await fixture();
 if(kind==='sql')f.options.db.query.mockRejectedValue(Error('private SQL credentials'));
 if(kind==='store')f.options.store.get.mockRejectedValue(Error('private URL'));
 if(kind==='scope')f.options.assertScope.mockImplementation(()=>{throw Error('private scope');});
 await expect(proveAuthCommitCohort(f.options,new AbortController().signal)).rejects.toThrow(/^AUTH_COHORT_PROOF_UNVERIFIED$/);expect(f.options.store.put).not.toHaveBeenCalled();
});
it('does no I/O after caller cancellation and bounds a stalled read',async()=>{
 const f=await fixture();await expect(proveAuthCommitCohort(f.options,AbortSignal.abort())).rejects.toThrow();expect(f.options.db.query).not.toHaveBeenCalled();
 f.options.store.get.mockImplementation(()=>new Promise(()=>{}));
 await expect(proveAuthCommitCohort(f.options,AbortSignal.timeout(25))).rejects.toThrow('AUTH_COHORT_PROOF_UNVERIFIED');expect(f.options.db.query).toHaveBeenCalledTimes(1);expect(f.options.store.put).not.toHaveBeenCalled();
});
it('rejects journal control drift during the SQL state check',async()=>{
 const f=await fixture(),query=f.options.db.query.getMockImplementation()!;
 f.options.db.query.mockImplementation(async(text,values)=>{const result=await query(text,values);if(!text.includes('LIMIT 5'))f.rows.set('control.json',JSON.stringify({...f.control,mode:'quarantine',reason:'synthetic'}));return result;});
 await expect(proveAuthCommitCohort(f.options,new AbortController().signal)).rejects.toThrow('AUTH_COHORT_PROOF_UNVERIFIED');
});
it.each(['body','sql'])('bounds a stalled %s without proceeding to later evidence',async kind=>{
 const f=await fixture();
 if(kind==='body')f.options.store.get.mockResolvedValue({etag:'synthetic',text:()=>new Promise<string>(()=>{})});
 else f.options.db.query.mockImplementation(()=>new Promise(()=>{}));
 await expect(proveAuthCommitCohort(f.options,AbortSignal.timeout(25))).rejects.toThrow('AUTH_COHORT_PROOF_UNVERIFIED');
 expect(f.options.db.query).toHaveBeenCalledTimes(1);expect(f.options.store.put).not.toHaveBeenCalled();
});
