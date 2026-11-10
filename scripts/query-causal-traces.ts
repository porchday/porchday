/** Restricted operator CLI. Fixed read-only SQL; never print provider errors. */
import {spawnSync} from 'node:child_process';
import {causalOtlp} from './causal-otlp.ts';
const [environment,view='recent',argument]=process.argv.slice(2);
if(!['staging','production'].includes(environment)||!['recent','trace','errors','health','otlp'].includes(view))throw Error('USE_ENVIRONMENT_RECENT_TRACE_ERRORS_HEALTH_OTLP');
if(['trace','otlp'].includes(view)&&!/^[a-f0-9]{32}$/.test(argument??''))throw Error('TRACE_ID_REQUIRED');
const since=Date.now()-86400000,now=Date.now();
const queries={
 recent:`SELECT trace_id,root_id,datetime(started_at/1000,'unixepoch') AS started,route,status,reason,json_extract(payload,'$.service') AS service,json_extract(payload,'$.kind') AS kind,json_extract(payload,'$.duration') AS duration_ms,json_extract(payload,'$.droppedSpans') AS dropped_spans FROM operational_traces WHERE started_at>${since} AND expires_at>${now} ORDER BY started_at DESC LIMIT 100`,
 trace:`SELECT payload FROM operational_traces WHERE (trace_id='${argument}' OR root_id IN (SELECT root_id FROM operational_trace_links WHERE linked_trace='${argument}' AND expires_at>${now})) AND expires_at>${now} ORDER BY started_at LIMIT 200`,
 errors:`SELECT route,status,count(*) AS retained_traces,max(json_extract(payload,'$.duration')) AS max_ms FROM operational_traces WHERE reason='error' AND started_at>${since} AND expires_at>${now} GROUP BY route,status ORDER BY retained_traces DESC LIMIT 100`,
 health:`SELECT count(*) AS retained_last_day,max(updated_at) AS latest_ingestion,sum(CASE WHEN reason='error' THEN 1 ELSE 0 END) AS errors,sum(CASE WHEN json_extract(payload,'$.droppedSpans')>0 THEN 1 ELSE 0 END) AS truncated_traces FROM operational_traces WHERE started_at>${since} AND expires_at>${now}`,
};
const sql=queries[view==='otlp'?'trace':view as keyof typeof queries];
const result=spawnSync('npx',['wrangler','d1','execute',`porchday-${environment}-traces`,'--remote','-c',`wrangler.${environment}.jsonc`,'--json','--command',sql],{cwd:'apps/api',encoding:'utf8',maxBuffer:16*1024*1024,timeout:30000});
if(result.status!==0)throw Error('CAUSAL_QUERY_FAILED');
const data=JSON.parse(result.stdout).flatMap((part:{results?:unknown[]})=>part.results??[]);
const records=['trace','otlp'].includes(view)?data.map((r:{payload:string})=>JSON.parse(r.payload)):data;
if(view!=='otlp')console.log(JSON.stringify({environment,view,at:new Date().toISOString(),data:records},null,2));
else console.log(JSON.stringify(causalOtlp(records),null,2));
