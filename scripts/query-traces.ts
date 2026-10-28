/** Read opt-in performance traces from D1 (docs/performance-tracing.md).
 *
 *   npx tsx scripts/query-traces.ts <local|staging|production> recent [member-uuid]
 *   npx tsx scripts/query-traces.ts <env> show <trace-id>
 *   npx tsx scripts/query-traces.ts <env> slow [hours]
 *
 * Uses wrangler's own Cloudflare login; credentials never pass through here.
 */
import {spawnSync} from 'node:child_process';
import {traceReport} from '../apps/web/src/tracing';

const [environment,view='recent',argument]=process.argv.slice(2);
if(!['local','staging','production'].includes(environment)||!['recent','show','slow'].includes(view))
 throw Error('USE_QUERY_TRACES_ENVIRONMENT_RECENT_SHOW_OR_SLOW');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,hex32=/^[0-9a-f]{32}$/;

export function d1(sql:string):Record<string,unknown>[] {
 const target=environment==='local'?['--local','-c','wrangler.local.jsonc']:['--remote','-c','wrangler.'+environment+'.jsonc'];
 const result=spawnSync('npx',['wrangler','d1','execute','porchday-'+environment+'-traces',...target,'--json','--command',sql],{cwd:'apps/api',encoding:'utf8',maxBuffer:64*1024*1024});
 if(result.status!==0)throw Error('D1_QUERY_FAILED: '+(result.stderr||result.stdout).split('\n').find(line=>/error/i.test(line))?.slice(0,200));
 const parsed=JSON.parse(result.stdout);
 return (Array.isArray(parsed)?parsed.at(-1):parsed).results??[];
}
function percentile(sorted:number[],p:number):number {return sorted.length?sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]:0;}

if(view==='recent'){
 if(argument&&!uuid.test(argument))throw Error('MEMBER_ID_MUST_BE_A_UUID');
 const rows=d1(`SELECT trace_id,member_id,datetime(started_at/1000,'unixepoch') AS started,page,browser,connection,edge,span_count
  FROM traces ${argument?`WHERE member_id='${argument}'`:''} ORDER BY started_at DESC LIMIT 30`);
 console.table(rows);
}else if(view==='show'){
 if(!argument||!hex32.test(argument))throw Error('TRACE_ID_MUST_BE_32_HEX');
 const [meta]=d1(`SELECT * FROM traces WHERE trace_id='${argument}'`);
 if(!meta)throw Error('TRACE_NOT_FOUND');
 const spans=d1(`SELECT seq,parent_seq,kind,name,start_ms,duration_ms,attrs FROM trace_spans WHERE trace_id='${argument}' ORDER BY start_ms,seq LIMIT 5000`)
  .map(row=>({...row,attrs:typeof row.attrs==='string'?JSON.parse(row.attrs):null}));
 console.log(traceReport({...meta,spans} as Parameters<typeof traceReport>[0]));
}else{
 const hours=Number(argument??24);
 if(!Number.isInteger(hours)||hours<1||hours>24*14)throw Error('HOURS_MUST_BE_1_TO_336');
 // Route patterns from the Worker keep per-ID photo requests in one group.
 const rows=d1(`SELECT s.kind,CASE WHEN s.kind='resource' AND json_extract(s.attrs,'$.route') IS NOT NULL
   THEN substr(s.name,1,instr(s.name,' '))||json_extract(s.attrs,'$.route') ELSE s.name END AS name,s.duration_ms
  FROM trace_spans s JOIN traces t USING(trace_id)
  WHERE t.received_at>${Date.now()-hours*3_600_000} AND s.kind IN ('resource','server','measure','navigation') LIMIT 50000`);
 const groups=new Map<string,number[]>();
 for(const row of rows){const key=row.kind+' '+row.name;groups.set(key,[...(groups.get(key)??[]),Number(row.duration_ms)]);}
 const summary=[...groups].map(([span,values])=>{values.sort((a,b)=>a-b);return {span,count:values.length,p50:Math.round(percentile(values,0.5)),p95:Math.round(percentile(values,0.95)),max:Math.round(values.at(-1)!)};})
  .filter(row=>row.count>=3).sort((a,b)=>b.p95-a.p95).slice(0,40);
 console.table(summary);
}
