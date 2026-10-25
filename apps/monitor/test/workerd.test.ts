import {describe,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';

describe('Monitor with a real local Durable Object',()=>{
  it('persists cron observations independently and exposes only a generic public read',async()=>{
    const compiled=await build({entryPoints:[new URL('../src/index.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
    const mf=new Miniflare(convertV4MiniflareOptions({name:'monitor-test',modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-10-24',durableObjects:{STATE:{className:'Monitor',useSQLite:true}},bindings:{ENVIRONMENT:'staging',OPERATIONS_HEALTH_TOKEN:''}}));
    try{
      const initial=await mf.dispatchFetch('https://status.porchday.test/status');expect(initial.status).toBe(200);expect(await initial.json()).toEqual({status:'unknown',last_checked_at:null});
      expect((await mf.dispatchFetch('https://status.porchday.test/tick',{method:'POST'})).status).toBe(404);
      const ns=await mf.getDurableObjectNamespace('STATE');const object=ns.get(ns.idFromName('monitor-v1'));
      // Missing token makes a failed observation without contacting the network.
      expect((await object.fetch('https://monitor.internal/tick',{method:'POST',headers:{'X-Scheduled-Minute':String(Math.floor(Date.now()/60000))}})).status).toBe(200);
      const result=await(await mf.dispatchFetch('https://status.porchday.test/status')).json() as {status:string;last_checked_at:string};
      expect(result.status).toBe('checking');expect(Date.parse(result.last_checked_at)).toBeGreaterThan(Date.now()-10000);
      expect(Object.keys(result).sort()).toEqual(['last_checked_at','status']);
      const page=await mf.dispatchFetch('https://status.porchday.test/');expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');expect(await page.text()).toContain('Checking service status');
    }finally{await mf.dispose();}
  });
});
