import {JOURNAL_PHASES} from '../apps/api/src/journal-phases';
/** Fixed read-only aggregate queries. Credentials stay in the process environment. */
import {FEED_PHASES} from '../apps/api/src/telemetry';
import {metricsQuery,parseAggregates,securitySignals} from '../apps/monitor/src/metrics';
const environment=process.argv[2],view=process.argv[3]??'summary';
if(!['staging','production'].includes(environment)||!['summary','counters','freshness','usage','feed-phases','logout-phases','security','trace-store','connections','db-snapshot'].includes(view))throw Error('USE_QUERY_METRICS_ENVIRONMENT_AND_A_VIEW');
if(view==='feed-phases'&&environment!=='staging')throw Error('FEED_PHASES_STAGING_ONLY');
const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_ANALYTICS_READ_TOKEN??process.env.CLOUDFLARE_API_TOKEN??process.env.CF_API_TOKEN;
if(!account||!/^[a-f0-9]{32}$/.test(account)||!token)throw Error('ANALYTICS_READ_CREDENTIALS_REQUIRED');
const dataset='porchday_'+environment+'_operations_v1';
const queries={
 'logout-phases':`SELECT blob6 AS phase,count() AS observed_points,sum(_sample_interval) AS events,
  sum(double2*_sample_interval)/sum(_sample_interval) AS mean_ms,
  quantileExactWeighted(0.50)(double2,_sample_interval) AS p50_ms,
  quantileExactWeighted(0.95)(double2,_sample_interval) AS p95_ms
  FROM ${dataset} WHERE timestamp>NOW()-INTERVAL '15' MINUTE
  AND blob1='porchday_metrics_v1' AND blob2='${environment}' AND blob3='journal_phase'
  AND blob4='/api/auth/sign-out' AND blob5='POST' AND double2>=0
  AND blob6 IN (${JOURNAL_PHASES.map(phase=>"'"+phase+"'").join(',')})
  GROUP BY phase ORDER BY phase FORMAT JSON`,
 security:metricsQuery(environment as 'staging'|'production'),
 'feed-phases':`SELECT blob6 AS phase,count() AS observed_points,sum(_sample_interval) AS events,
  sum(double2*_sample_interval)/sum(_sample_interval) AS mean_ms,
  quantileExactWeighted(0.50)(double2,_sample_interval) AS p50_ms,
  quantileExactWeighted(0.95)(double2,_sample_interval) AS p95_ms
  FROM ${dataset} WHERE timestamp>NOW()-INTERVAL '15' MINUTE
  AND blob1='porchday_metrics_v1' AND blob2='staging' AND blob3='feed_phase'
  AND blob4='/api/v1/feed' AND blob5='GET' AND double2>=0
  AND blob6 IN (${FEED_PHASES.map(phase=>"'"+phase+"'").join(',')})
  GROUP BY phase ORDER BY phase FORMAT JSON`,
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
 // D1 health for performance traces: outcomes, wall time, D1's own duration
 // (double4) and rows touched, over the last hour.
 'trace-store':`SELECT blob6 AS code,sum(_sample_interval) AS events,
  sum(double2*_sample_interval)/sum(_sample_interval) AS mean_ms,
  quantileExactWeighted(0.95)(double2,_sample_interval) AS p95_ms,
  quantileExactWeighted(0.95)(double4,_sample_interval) AS store_p95_ms,
  sum(double3*_sample_interval) AS quantity FROM ${dataset}
  WHERE timestamp>NOW()-INTERVAL '60' MINUTE AND blob1='porchday_metrics_v1'
  AND blob3='trace_store' GROUP BY code ORDER BY events DESC FORMAT JSON`,
 // Issue #40: which routes and jobs hold Postgres connections, for how long,
 // and how much of that is after the response (last hour). held_seconds/3600
 // is the average number of connections that route kept open.
 connections:`SELECT blob4 AS route,blob6 AS code,sum(_sample_interval) AS events,
  sum(double3*_sample_interval) AS quantity,
  sum(double2*_sample_interval)/1000 AS held_seconds,
  quantileExactWeighted(0.95)(double2,_sample_interval) AS p95_ms,
  sum(if(double4>0,double4,0)*_sample_interval)/1000 AS after_response_seconds
  FROM ${dataset} WHERE timestamp>NOW()-INTERVAL '60' MINUTE AND blob1='porchday_metrics_v1'
  AND blob3='db_conn' GROUP BY route,code ORDER BY held_seconds DESC,events DESC LIMIT 150 FORMAT JSON`,
 // Server-wide connections by role and state, once a minute (last 15 minutes).
 'db-snapshot':`SELECT toStartOfMinute(timestamp) AS minute,blob6 AS code,
  max(double3) AS connections,max(double2) AS oldest_ms
  FROM ${dataset} WHERE timestamp>NOW()-INTERVAL '15' MINUTE AND blob1='porchday_metrics_v1'
  AND blob3='db_snapshot' GROUP BY minute,code ORDER BY minute DESC,code LIMIT 200 FORMAT JSON`,
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
 const columns=new Set(['route','kind','code','requests','server_errors','mean_ms','p95_ms','events','quantity','latest_timestamp','estimated_events','store_p95_ms','held_seconds','after_response_seconds','minute','connections','oldest_ms']);
 const phaseColumns=new Set(['observed_points','events','mean_ms','p50_ms','p95_ms']);
 function phaseRows(rows:Record<string,unknown>[]){
  const safe:Record<string,string|number>[]=[];
  for(const row of rows){
   if(!row||typeof row.phase!=='string'||!((view==='logout-phases'?JOURNAL_PHASES:FEED_PHASES) as readonly string[]).includes(row.phase))continue;
   const item:Record<string,string|number>={phase:row.phase};
   for(const key of phaseColumns){
    const value=row[key];
    if(typeof value!=='number'&&!(typeof value==='string'&&/^[0-9]+(?:\.[0-9]+)?$/.test(value)))continue;
    if(Number.isFinite(Number(value))&&Number(value)>=0)item[key]=Number(value);
   }
   safe.push(item);
  }
  return safe;
 }
 if(view==='security'){
  const rows=parseAggregates(result,Date.now());
  const data=rows.filter(row=>['/api/auth/sign-in/email','/api/auth/reset-password','/api/auth/verify-email','/api/auth/*','/api/account-recovery/*'].includes(row.route)).map(({route,requests,observations,failed_requests})=>({route,requests,observations,failed_requests}));
  console.log(JSON.stringify({environment,view,signals:securitySignals(rows),data},null,2));
 }else{
 const data=view==='feed-phases'||view==='logout-phases'
  ?phaseRows(result.data)
  :result.data.map((row:Record<string,unknown>)=>Object.fromEntries(Object.entries(row).filter(([key,value])=>columns.has(key)&&(value===null||typeof value==='number'||(typeof value==='string'&&value.length<=80)))));
 console.log(JSON.stringify({environment,view,data},null,2));
 }
}catch(error){
 const code=(error as Error).message;
 console.error(/^ANALYTICS_[A-Z_]+$/.test(code)?code:'ANALYTICS_QUERY_UNAVAILABLE');process.exitCode=1;
}
