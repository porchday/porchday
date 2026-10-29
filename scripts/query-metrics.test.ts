import {afterEach,expect,test,vi} from 'vitest';

const originalArgv=process.argv;
const originalExitCode=process.exitCode;
afterEach(()=>{process.argv=originalArgv;process.exitCode=originalExitCode;vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});

async function invoke(view:string,response:Response,environment='staging'){
 process.argv=['node','query-metrics.ts',environment,view];
 vi.stubEnv('CLOUDFLARE_ACCOUNT_ID','a'.repeat(32));
 vi.stubEnv('CLOUDFLARE_ANALYTICS_READ_TOKEN','synthetic-read-capability');
 const fetcher=vi.fn(async()=>response),output=vi.spyOn(console,'log').mockImplementation(()=>{}),errors=vi.spyOn(console,'error').mockImplementation(()=>{});
 vi.stubGlobal('fetch',fetcher);vi.resetModules();await import('./query-metrics');
 return {fetcher,output,errors};
}

test('fixed aggregate query uses sampling weights and private bearer authentication without printing diagnostics',async()=>{
 const {fetcher,output,errors}=await invoke('summary',Response.json({data:[{route:'/api/v1/feed',requests:12,p95_ms:34,provider_debug:'private-token',raw_url:'https://private.example'}],diagnostics:'private SQL diagnostics'}));
 expect(fetcher).toHaveBeenCalledTimes(1);
 const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
 expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/analytics_engine/sql');
 expect(options).toMatchObject({method:'POST',redirect:'error',headers:{Authorization:'Bearer synthetic-read-capability'}});
 expect(options.signal).toBeInstanceOf(AbortSignal);
 expect(options.body).toContain('FROM porchday_staging_operations_v1');
 expect(options.body).toContain('sum(_sample_interval)');
 expect(options.body).toContain('quantileExactWeighted(0.95)(double2,_sample_interval)');
 expect(JSON.parse(output.mock.calls[0][0])).toEqual({environment:'staging',view:'summary',data:[{route:'/api/v1/feed',requests:12,p95_ms:34}]});
 expect(JSON.stringify(output.mock.calls)).not.toMatch(/private|capability/);expect(errors).not.toHaveBeenCalled();
});

test('provider failures suppress response content and do not print credentials',async()=>{
 const {output,errors}=await invoke('counters',new Response('private provider details and synthetic-read-capability',{status:403}));
 expect(output).not.toHaveBeenCalled();expect(errors).toHaveBeenCalledExactlyOnceWith('ANALYTICS_QUERY_FAILED');expect(process.exitCode).toBe(1);
});

test('aggregate reader stops at its response size bound',async()=>{
 const {output,errors}=await invoke('freshness',new Response('a'.repeat(1024*1024+1)));
 expect(output).not.toHaveBeenCalled();expect(errors).toHaveBeenCalledExactlyOnceWith('ANALYTICS_RESPONSE_TOO_LARGE');expect(process.exitCode).toBe(1);
});

test('feed phase query is fixed, weighted and exposes only allowlisted phases plus numeric aggregates',async()=>{
 const {fetcher,output,errors}=await invoke('feed-phases',Response.json({data:[
  {phase:'social_query',observed_points:'100',events:'100',mean_ms:'34.5',p50_ms:30,p95_ms:50,token:'private-token',route:'/private'},
  {phase:'private-member',events:1,p95_ms:50},
  {phase:'auth_session',mean_ms:'private-token',p95_ms:Infinity},
 ]}));
 const sql=(fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body as string;
 expect(sql).toContain("blob2='staging' AND blob3='feed_phase'");expect(sql).toContain("blob4='/api/v1/feed' AND blob5='GET'");
 expect(sql).toContain('count() AS observed_points');expect(sql).toContain('quantileExactWeighted(0.95)(double2,_sample_interval)');
 expect(JSON.parse(output.mock.calls[0][0])).toEqual({environment:'staging',view:'feed-phases',data:[{phase:'social_query',observed_points:100,events:100,mean_ms:34.5,p50_ms:30,p95_ms:50},{phase:'auth_session'}]});
 expect(JSON.stringify(output.mock.calls)).not.toMatch(/private|capability/);expect(errors).not.toHaveBeenCalled();
});

test('feed phase reader rejects production before making a request',async()=>{
 await expect(invoke('feed-phases',Response.json({data:[]}),'production')).rejects.toThrow('FEED_PHASES_STAGING_ONLY');
 expect(fetch).not.toHaveBeenCalled();
});
test('security view shares the monitor query and returns only validated fixed routes and aggregate failure evidence',async()=>{
 const {fetcher,output,errors}=await invoke('security',Response.json({data:[{route:'/api/account-recovery/*',requests:100,observations:50,server_errors:0,failed_requests:25,p95_ms:5,latest_timestamp:new Date().toISOString(),private_debug:'private token'}]}));
 expect((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body).toContain('AS failed_requests');
 expect(JSON.parse(output.mock.calls[0][0])).toEqual({environment:'staging',view:'security',signals:{authentication:null,recovery:false},data:[{route:'/api/account-recovery/*',requests:100,observations:50,failed_requests:25}]});
 expect(JSON.stringify(output.mock.calls)).not.toContain('private');expect(errors).not.toHaveBeenCalled();
});

test('trace-store view reports D1 write outcomes, wall time and D1 duration',async()=>{
 const {fetcher,output,errors}=await invoke('trace-store',Response.json({data:[{code:'trace_write_ok',events:40,mean_ms:31.5,p95_ms:88,store_p95_ms:4.2,quantity:900,member:'private'}]}),'production');
 const [,options]=fetcher.mock.calls[0];
 expect(options.body).toContain("blob3='trace_store'");expect(options.body).toContain('FROM porchday_production_operations_v1');
 expect(JSON.parse(output.mock.calls[0][0])).toEqual({environment:'production',view:'trace-store',data:[{code:'trace_write_ok',events:40,mean_ms:31.5,p95_ms:88,store_p95_ms:4.2,quantity:900}]});
 expect(errors).not.toHaveBeenCalled();
});

test('connection views query only db_conn and db_snapshot points and return bounded columns',async()=>{
 const connections=await invoke('connections',Response.json({data:[{route:'/api/v1/media/:id/bytes',code:'auth_close',events:12,quantity:24,held_seconds:30.5,p95_ms:4100,after_response_seconds:12.25,query:'private'}]}),'production');
 expect(connections.fetcher.mock.calls[0][1].body).toContain("blob3='db_conn'");
 expect(JSON.parse(connections.output.mock.calls[0][0]).data).toEqual([{route:'/api/v1/media/:id/bytes',code:'auth_close',events:12,quantity:24,held_seconds:30.5,p95_ms:4100,after_response_seconds:12.25}]);
 const snapshot=await invoke('db-snapshot',Response.json({data:[{minute:'2026-10-28 07:31:00',code:'jobs_idle_in_transaction',connections:3,oldest_ms:65000}]}),'production');
 expect(snapshot.fetcher.mock.calls.at(-1)![1].body).toContain("blob3='db_snapshot'");
 expect(JSON.parse(snapshot.output.mock.calls.at(-1)![0]).data).toEqual([{minute:'2026-10-28 07:31:00',code:'jobs_idle_in_transaction',connections:3,oldest_ms:65000}]);
});

test('denial cleanup reader weights phase totals and attempt counts and suppresses private values',async()=>{
 const {fetcher,output}=await invoke('denial-cleanup-phases',Response.json({data:[
  {phase:'authority_batches',total_ms:'200',attempts:10,events:2,private:'hidden'},
  {phase:'private-token',total_ms:3},{phase:'sql_list',attempts:-1,total_ms:'private-token'},
 ]}));
 const sql=fetcher.mock.calls[0][1].body;
 expect(sql).toContain("blob3='denial_cleanup_phase'");
 expect(sql).toContain('sum(double2*_sample_interval) AS total_ms');
 expect(sql).toContain('sum(double3*_sample_interval) AS attempts');
 expect(JSON.parse(output.mock.calls[0][0]).data).toEqual([{phase:'authority_batches',events:2,total_ms:200,attempts:10},{phase:'sql_list'}]);
});
test('denial cleanup reader rejects production before network access',async()=>{
 await expect(invoke('denial-cleanup-phases',Response.json({data:[]}),'production')).rejects.toThrow('DENIAL_CLEANUP_PHASES_STAGING_ONLY');
 expect(fetch).not.toHaveBeenCalled();
});
