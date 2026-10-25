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
