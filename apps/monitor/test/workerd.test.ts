import {describe,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';

describe('Monitor with a real local Durable Object',()=>{
  it('performs all outbound checks in workerd and rejects redirects without forwarding credentials',async()=>{
    const compiled=await build({entryPoints:[new URL('../src/index.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
    for(const redirect of [false,true]){
      const calls:{url:string;authorization:string|null}[]=[];
      const mf=new Miniflare(convertV4MiniflareOptions({name:'outbound-monitor',modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-24',durableObjects:{STATE:{className:'Monitor',useSQLite:true}},bindings:{ENVIRONMENT:'staging',OPERATIONS_HEALTH_TOKEN:'synthetic-health-capability-123456789',METRICS_ENABLED:'true',ANALYTICS_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_ANALYTICS_READ_TOKEN:'synthetic-read-capability-123456789'},outboundService:async(request:Request)=>{
        calls.push({url:request.url,authorization:request.headers.get('authorization')});
        if(redirect)return new Response(null,{status:302,headers:{Location:'https://attacker.test/capture'}});
        const path=new URL(request.url).pathname;
        if(path==='/api/operations/health')return Response.json({status:'ok',issues:[],snapshot:{cleanup_age_seconds:0}});
        if(path==='/health')return Response.json({status:'ok',service:'porchday',environment:'staging'});
        if(path.endsWith('/analytics_engine/sql'))return Response.json({data:[{route:'/health',requests:'1',observations:'1',server_errors:'0',failed_requests:'0',p95_ms:'10',latest_timestamp:new Date().toISOString()}]});
        return new Response(null,{status:500});
      }}));
      try{
        const ns=await mf.getDurableObjectNamespace('STATE');const object=ns.get(ns.idFromName('monitor-v1'));
        expect((await object.fetch('https://monitor.internal/tick',{method:'POST',headers:{'X-Scheduled-Minute':String(Math.floor(Date.now()/60000))}})).status).toBe(200);
        const result=await(await mf.dispatchFetch('https://status.porchday.test/status')).json();
        expect(result).toMatchObject({status:redirect?'checking':'operational',metrics_monitoring:redirect?'unavailable':'ready'});
        expect(calls).toHaveLength(3);expect(calls.every(call=>!call.url.includes('attacker.test'))).toBe(true);
        expect(calls.find(call=>call.url.endsWith('/api/operations/health'))?.authorization).toBe('Bearer synthetic-health-capability-123456789');
        expect(calls.find(call=>call.url.endsWith('/analytics_engine/sql'))?.authorization).toBe('Bearer synthetic-read-capability-123456789');
        expect(calls.find(call=>call.url.endsWith('/health')&&!call.url.includes('/operations/'))?.authorization).toBeNull();
      }finally{await mf.dispose();}
    }
  });
  it('persists cron observations independently and exposes only a generic public read',async()=>{
    const compiled=await build({entryPoints:[new URL('../src/index.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
    const mf=new Miniflare(convertV4MiniflareOptions({name:'monitor-test',modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-24',durableObjects:{STATE:{className:'Monitor',useSQLite:true}},bindings:{ENVIRONMENT:'staging',OPERATIONS_HEALTH_TOKEN:''}}));
    try{
      const initial=await mf.dispatchFetch('https://status.porchday.test/status');expect(initial.status).toBe(200);expect(await initial.json()).toEqual({status:'unknown',last_checked_at:null,metrics_monitoring:'not_configured'});
      expect((await mf.dispatchFetch('https://status.porchday.test/tick',{method:'POST'})).status).toBe(404);
      const ns=await mf.getDurableObjectNamespace('STATE');const object=ns.get(ns.idFromName('monitor-v1'));
      // Missing token makes a failed observation without contacting the network.
      expect((await object.fetch('https://monitor.internal/tick',{method:'POST',headers:{'X-Scheduled-Minute':String(Math.floor(Date.now()/60000))}})).status).toBe(200);
      const result=await(await mf.dispatchFetch('https://status.porchday.test/status')).json() as {status:string;last_checked_at:string};
      expect(result.status).toBe('checking');expect(Date.parse(result.last_checked_at)).toBeGreaterThan(Date.now()-10000);
      expect(Object.keys(result).sort()).toEqual(['last_checked_at','metrics_monitoring','status']);
      const page=await mf.dispatchFetch('https://status.porchday.test/');expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');expect(await page.text()).toContain('Checking service status');
    }finally{await mf.dispose();}
  });
});
