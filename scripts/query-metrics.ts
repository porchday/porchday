/** Fixed read-only aggregate queries. Credentials stay in the process environment. */
const environment=process.argv[2],view=process.argv[3]??'summary';
if(!['staging','production'].includes(environment)||!['summary','counters','freshness','usage'].includes(view))throw Error('USE_QUERY_METRICS_ENVIRONMENT_SUMMARY_COUNTERS_FRESHNESS_OR_USAGE');
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_ANALYTICS_READ_TOKEN??process.env.CLOUDFLARE_API_TOKEN??process.env.CF_API_TOKEN;
if(!account||!/^[a-f0-9]{32}$/.test(account)||!token)throw Error('ANALYTICS_READ_CREDENTIALS_REQUIRED');
const dataset='porchday_'+environment+'_operations_v1';
const queries={
 summary:`SELECT blob4 AS route, sum(_sample_interval) AS requests,
  sum(if(double1>=500,_sample_interval,0)) AS server_errors,
  sum(double2*_sample_interval)/sum(_sample_interval) AS mean_ms,
  quantileExactWeighted(0.95)(double2,_sample_interval) AS p95_ms
  FROM ${dataset} WHERE timestamp>NOW()-INTERVAL '15' MINUTE
  AND blob1='porchday_metrics_v1' AND blob3='request' AND double2>=0
  GROUP BY route ORDER BY requests DESC FORMAT JSON`,
 counters:`SELECT blob3 AS kind,blob6 AS code,sum(_sample_interval) AS events,
  sum(double3*_sample_interval) AS quantity FROM ${dataset}
  WHERE timestamp>NOW()-INTERVAL '15' MINUTE AND blob1='porchday_metrics_v1'
  AND blob3 IN ('job','email','error') GROUP BY kind,code ORDER BY events DESC FORMAT JSON`,
 freshness:`SELECT max(timestamp) AS latest_timestamp,sum(_sample_interval) AS events
  FROM ${dataset} WHERE timestamp>NOW()-INTERVAL '15' MINUTE
  AND blob1='porchday_metrics_v1' FORMAT JSON`,
 usage:`SELECT sum(_sample_interval) AS estimated_events FROM ${dataset}
  WHERE timestamp>NOW()-INTERVAL '30' DAY AND blob1='porchday_metrics_v1' FORMAT JSON`,
};
try{
 const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/analytics_engine/sql',{
  method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'text/plain'},body:queries[view as keyof typeof queries],redirect:'error',signal:AbortSignal.timeout(30_000),
 });
 if(!response.ok)throw Error('ANALYTICS_QUERY_FAILED');
 const reader=response.body?.getReader();if(!reader)throw Error('ANALYTICS_EMPTY_RESPONSE');
 let length=0;const chunks:Uint8Array[]=[];
 for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>1024*1024){await reader.cancel();throw Error('ANALYTICS_RESPONSE_TOO_LARGE');}chunks.push(value);}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const result=JSON.parse(new TextDecoder().decode(bytes));
 if(!Array.isArray(result.data)||result.data.length>200)throw Error('ANALYTICS_RESPONSE_INVALID');
 // Never print provider diagnostic payloads. These fixed queries return only
 // bounded labels from our exporter, aggregate values and provider timestamps.
 const columns=new Set(['route','kind','code','requests','server_errors','mean_ms','p95_ms','events','quantity','latest_timestamp','estimated_events']);
 const data=result.data.map((row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([key,value])=>columns.has(key)&&(value===null||typeof value==='number'||(typeof value==='string'&&value.length<=80)))));
 console.log(JSON.stringify({environment,view,data},null,2));
}catch(error){
 const code=(error as Error).message;
 console.error(/^ANALYTICS_[A-Z_]+$/.test(code)?code:'ANALYTICS_QUERY_UNAVAILABLE');process.exitCode=1;
}
