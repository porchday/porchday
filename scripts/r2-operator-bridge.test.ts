import {describe,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {randomUUID,createHash} from 'node:crypto';
import {canonicalJson} from '@porchday/crypto';

describe('Ephemeral operator Worker with real local R2 bindings',()=>{
  it('denies missing or expired capability metadata before touching storage',async()=>{
    for(const expires of[undefined,String(Date.now()-1000),'invalid']){
      const mf=new Miniflare(convertV4MiniflareOptions({name:'operator',modules:true,scriptPath:new URL('./r2-operator-worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-10-01',bindings:{OPERATOR_BEARER:'synthetic-operator-test',...(expires===undefined?{}:{OPERATOR_EXPIRES_AT:expires})},r2Buckets:['JOURNAL']}));
      try{const response=await mf.dispatchFetch('https://ops.porchday.test/journal/put',{method:'POST',headers:{Authorization:'Bearer synthetic-operator-test','Content-Type':'application/json'},body:JSON.stringify({key:'control.json',value:'{}',ifNoneMatch:'*'})});expect(response.status).toBe(401);expect(await(await mf.getR2Bucket('JOURNAL')).get('control.json')).toBeNull();}finally{await mf.dispose();}
    }
  });
  it('limits a verifier to reads and the disposable probe namespace',async()=>{
    const mf=new Miniflare(convertV4MiniflareOptions({name:'operator',modules:true,scriptPath:new URL('./r2-operator-worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-10-01',bindings:{OPERATOR_BEARER:'synthetic-operator-test',OPERATOR_EXPIRES_AT:String(Date.now()+60_000),JOURNAL_ACCESS:'read-only'},r2Buckets:['JOURNAL']}));
    try{const call=(key:string)=>mf.dispatchFetch('https://ops.porchday.test/journal/put',{method:'POST',headers:{Authorization:'Bearer synthetic-operator-test','Content-Type':'application/json'},body:JSON.stringify({key,value:'{}',ifNoneMatch:'*'})});expect((await call('control.json')).status).toBe(403);expect((await call('probes/'+randomUUID()+'.json')).status).toBe(200);expect(await(await mf.getR2Bucket('JOURNAL')).get('control.json')).toBeNull();}finally{await mf.dispose();}
  });
  it('restores only an unexpired completed snapshot object with exact integrity and create-only destination',async()=>{
    const mf=new Miniflare(convertV4MiniflareOptions({name:'operator',modules:true,scriptPath:new URL('./r2-operator-worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-10-01',bindings:{OPERATOR_BEARER:'synthetic-operator-test',OPERATOR_EXPIRES_AT:String(Date.now()+60000)},r2Buckets:['JOURNAL','MEDIA','BACKUP']}));
    try{
      const backup=await mf.getR2Bucket('BACKUP'),media=await mf.getR2Bucket('MEDIA'),id=randomUUID(),key='media/'+randomUUID()+'/'+randomUUID(),data='synthetic encrypted bytes';
      const args={snapshotId:id,key,byteSize:Buffer.byteLength(data),sha256:createHash('sha256').update(data).digest('hex')};
      const call=(body:unknown)=>mf.dispatchFetch('https://ops.porchday.test/backup/restore',{method:'POST',headers:{Authorization:'Bearer synthetic-operator-test','Content-Type':'application/json'},body:JSON.stringify(body)});
      await backup.put('snapshots/'+id+'/objects/'+key.slice(6),data);
      expect((await call(args)).status).toBe(409);expect(await media.get(key)).toBeNull();
      await backup.put('snapshots/'+id+'/complete.json',JSON.stringify({run:{id,expires_at:new Date(Date.now()+60000).toISOString()}}));
      expect((await call({...args,sha256:'0'.repeat(64)})).status).toBe(409);expect((await call(args)).status).toBe(200);expect((await call(args)).status).toBe(200);expect(await(await media.get(key))!.text()).toBe(data);
      await media.put(key,'different existing object');expect((await call(args)).status).toBe(409);expect(await(await media.get(key))!.text()).toBe('different existing object');
      await backup.put('snapshots/'+id+'/complete.json',JSON.stringify({run:{id,expires_at:new Date(Date.now()-1000).toISOString()}}));expect((await call(args)).status).toBe(409);
      const envelope={z:'synthetic encrypted bytes 🌻',a:[1,true,null,{last:'value',first:'value'}]},raw=JSON.stringify(envelope),canonicalSha256=createHash('sha256').update(canonicalJson(envelope)).digest('hex');await media.put(key,raw);
      const verify=(hash:string)=>mf.dispatchFetch('https://ops.porchday.test/media/verify',{method:'POST',headers:{Authorization:'Bearer synthetic-operator-test','Content-Type':'application/json'},body:JSON.stringify({key,byteSize:Buffer.byteLength(raw),canonicalSha256:hash})});
      expect((await verify(canonicalSha256)).status).toBe(200);expect((await verify(createHash('sha256').update(raw).digest('hex'))).status).toBe(409);await media.delete(key);expect((await verify(canonicalSha256)).status).toBe(409);

    }finally{await mf.dispose();}
  });
  it('rejects unauthenticated mutations and requires conditional writes',async()=>{
    const mf=new Miniflare(convertV4MiniflareOptions({name:'operator',modules:true,scriptPath:new URL('./r2-operator-worker.mjs',import.meta.url).pathname,compatibilityDate:'2026-10-01',bindings:{OPERATOR_BEARER:'synthetic-operator-test',OPERATOR_EXPIRES_AT:String(Date.now()+60_000)},r2Buckets:['JOURNAL','MEDIA']}));
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
