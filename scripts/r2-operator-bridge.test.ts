import {describe,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {randomUUID} from 'node:crypto';

describe('Ephemeral operator Worker with real local R2 bindings',()=>{
  it('rejects unauthenticated mutations and requires conditional writes',async()=>{
    const mf=new Miniflare(convertV4MiniflareOptions({name:'operator',modules:true,scriptPath:new URL('./r2-operator-worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-10-01',bindings:{OPERATOR_BEARER:'synthetic-operator-test'},r2Buckets:['JOURNAL','MEDIA']}));
    try {
      const call=(path:string,body:unknown,authorized=true)=>mf.dispatchFetch('https://ops.porchday.test'+path,{method:'POST',headers:{...(authorized?{Authorization:'Bearer synthetic-operator-test'}:{}),'Content-Type':'application/json'},body:JSON.stringify(body)});
      expect((await call('/journal/put',{key:'control.json',value:'{}',ifNoneMatch:'*'},false)).status).toBe(401);
      const bucket=await mf.getR2Bucket('JOURNAL');expect(await bucket.get('control.json')).toBeNull();
      expect((await call('/journal/put',{key:'control.json',value:'{}'})).status).toBe(400);
      expect((await call('/journal/put',{key:'unrelated/object',value:'{}',ifNoneMatch:'*'})).status).toBe(400);
      const first=await call('/journal/put',{key:'control.json',value:'{"sequence":0}',ifNoneMatch:'*'});expect(first.status).toBe(200);const etag=(await first.json() as any).etag;
      expect((await call('/journal/put',{key:'control.json',value:'{"sequence":1}',ifNoneMatch:'*'})).status).toBe(412);
      expect((await call('/journal/put',{key:'control.json',value:'{"sequence":1}',ifMatch:etag})).status).toBe(200);
      expect((await call('/journal/put',{key:'control.json',value:'{"sequence":2}',ifMatch:etag})).status).toBe(412);
      expect(await (await bucket.get('control.json'))!.text()).toBe('{"sequence":1}');
      const immutable='receipts/'+randomUUID()+'.json';await call('/journal/put',{key:immutable,value:'{}',ifNoneMatch:'*'});
      expect((await call('/journal/put',{key:immutable,value:'changed',ifMatch:etag})).status).toBe(400);
      expect((await call('/probe/delete',{key:'control.json'})).status).toBe(403);
      expect((await call('/media/delete',{key:'control.json'})).status).toBe(400);
    } finally {await mf.dispose();}
  });
});
