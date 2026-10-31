import {expect,it,vi} from 'vitest';
import {parsePlacementConnections,readPlacementMetrics} from './placement-trial-telemetry.ts';
it('counts every observed client conservatively and never infers omitted groups',()=>{
 expect(parsePlacementConnections({max_connections:25,reserved_connections:3,groups:[{role:'auth',connections:5},{role:'other',connections:4},{role:'jobs',connections:1}]},1000)).toEqual({at:1000,total:10,usable:22,refused:false});
 expect(()=>parsePlacementConnections({max_connections:25,reserved_connections:3,groups:[]},1000)).toThrow();
 expect(()=>parsePlacementConnections({max_connections:25,reserved_connections:3,groups:[{role:'auth',connections:-1}]},1000)).toThrow();
});
it.each([null,0])('preserves missing/empty aggregate %s as missing instead of a zero-error guarantee',async requests=>{
 const fetcher=vi.fn(async(_input:any,init:any)=>Response.json({data:String(init.body).includes('AS requests')?[{requests,server_errors:0}]:[]}));
 const result=await readPlacementMetrics({accountId:'a'.repeat(32),token:'private-token'.repeat(3),environment:'production',fetch:fetcher},Date.now()-60000,new AbortController().signal);
 expect(result.allErrors).toBeNull();expect(result.coverage).toContain('absent groups');expect(fetcher).toHaveBeenCalledTimes(2);
 expect(JSON.stringify(result)).not.toContain('private-token');
});
it('retains weighted errors and makes a newly observed refusal actionable',async()=>{
 const fetcher=vi.fn(async(_input:any,init:any)=>Response.json({data:String(init.body).includes('AS requests')?[{requests:'100',server_errors:'3'}]:[{route:'/api/v1/feed',code:'refused_53300',count:'1'}]}));
 const result=await readPlacementMetrics({accountId:'a'.repeat(32),token:'t'.repeat(30),environment:'staging',fetch:fetcher},Date.now()-60000,new AbortController().signal);
 expect(result.allErrors).toEqual({requests:100,server_errors:3});expect(result.refused).toBe(true);
});
it('does not retry an unavailable analytics read or reveal its response',async()=>{
 const fetcher=vi.fn(async()=>new Response('private provider details',{status:503}));
 await expect(readPlacementMetrics({accountId:'a'.repeat(32),token:'t'.repeat(30),environment:'production',fetch:fetcher},Date.now()-60000,new AbortController().signal)).rejects.toThrow('TRIAL_METRICS_UNAVAILABLE');
 expect(fetcher).toHaveBeenCalledTimes(2);
});
