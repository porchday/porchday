const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const journalKey=key=>typeof key==='string' && (key==='control.json' || /^(intents|receipts|probes)\/[a-f0-9-]{36}\.json$/.test(key) || /^batches\/[a-f0-9-]{36}\/[0-9]+-[0-9]+-[a-f0-9]{64}\.json$/.test(key));
export default {async fetch(request,env) {
  // No body parsing, R2 access or diagnostic content before authorization.
  const expires=Number(env.OPERATOR_EXPIRES_AT);
  if(!Number.isFinite(expires)||expires<=Date.now()||!env.OPERATOR_BEARER || request.headers.get('Authorization')!=='Bearer '+env.OPERATOR_BEARER)return json({error:'UNAUTHORIZED'},401);
  if(request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
  const path=new URL(request.url).pathname;
  if(path==='/health')return json({ready:true});
  if(!['/journal/get','/journal/put','/probe/delete','/media/delete','/backup/restore','/media/verify'].includes(path))return json({error:'NOT_FOUND'},404);
  let body;try {
    const reader=request.body?.getReader();let length=0,chunks=[];
    if(!reader)return json({error:'INVALID_BODY'},400);
    for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>5*1024*1024){await reader.cancel();return json({error:'TOO_LARGE'},413);}chunks.push(value);}
    const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
    body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
  } catch{return json({error:'INVALID_BODY'},400);}
  try {
    if(path==='/media/verify'){
      if(!env.MEDIA||!/^media\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(body?.key)||!Number.isInteger(body.byteSize)||body.byteSize<1||body.byteSize>22020096||!/^[a-f0-9]{64}$/.test(body.canonicalSha256))return json({error:'INVALID_MEDIA_VERIFICATION'},400);
      const object=await env.MEDIA.get(body.key);if(!object||object.size!==body.byteSize)return json({error:'RESTORE_MEDIA_MISSING'},409);
      // Same sorted-key JSON encoding as canonicalJson, over parsed JSON only.
      const canonical=value=>{if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';throw Error('INVALID_JSON');};
      const text=canonical(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await object.arrayBuffer()))),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
      return digest===body.canonicalSha256?json({ok:true}):json({error:'RESTORE_MEDIA_HASH_MISMATCH'},409);
    }
    if(path==='/backup/restore'){
      if(!env.BACKUP||!env.MEDIA||typeof body.snapshotId!=='string'||!/^[a-f0-9-]{36}$/.test(body.snapshotId)||!/^media\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(body.key)||!Number.isInteger(body.byteSize)||body.byteSize<1||body.byteSize>22020096||!/^[a-f0-9]{64}$/.test(body.sha256))return json({error:'INVALID_BACKUP_COPY'},400);
      const prefix='snapshots/'+body.snapshotId+'/',complete=await env.BACKUP.get(prefix+'complete.json');
      if(!complete)return json({error:'BACKUP_INCOMPLETE'},409);
      const manifest=await complete.json(),expiry=Date.parse(manifest?.run?.expires_at);
      if(manifest?.run?.id!==body.snapshotId||!Number.isFinite(expiry)||expiry<=Date.now())return json({error:'BACKUP_EXPIRED'},409);
      const source=await env.BACKUP.get(prefix+'objects/'+body.key.slice(6));if(!source||source.size!==body.byteSize)return json({error:'BACKUP_OBJECT_MISSING'},409);
      const data=await source.arrayBuffer(),digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
      if(await digest(data)!==body.sha256)return json({error:'BACKUP_HASH_MISMATCH'},409);
      if(!await env.MEDIA.put(body.key,data,{onlyIf:{etagDoesNotMatch:'*'},sha256:body.sha256})){
        const existing=await env.MEDIA.get(body.key);if(!existing||existing.size!==body.byteSize||await digest(await existing.arrayBuffer())!==body.sha256)return json({error:'RESTORE_OBJECT_CONFLICT'},409);
      }
      return json({ok:true});
    }
    if(path==='/media/delete'){
      if(!env.MEDIA || !/^media\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(body?.key))return json({error:'INVALID_MEDIA_KEY'},400);
      await env.MEDIA.delete(body.key);return json({ok:true});
    }
    if(!journalKey(body?.key))return json({error:'INVALID_JOURNAL_KEY'},400);
    if(path==='/probe/delete'){
      if(!body.key.startsWith('probes/'))return json({error:'FORBIDDEN'},403);
      await env.JOURNAL.delete(body.key);return json({ok:true});
    }
    if(path==='/journal/get'){
      const object=await env.JOURNAL.get(body.key);return object?json({etag:object.etag,value:await object.text()}):json({missing:true},404);
    }
    if(env.JOURNAL_ACCESS==='read-only'&&!body.key.startsWith('probes/'))return json({error:'READ_ONLY'},403);
    const create=body.ifNoneMatch==='*',replace=typeof body.ifMatch==='string' && /^[a-fA-F0-9]{32}(?:-[0-9]+)?$/.test(body.ifMatch);
    if(typeof body.value!=='string' || Number(create)+Number(replace)!==1 || (body.key!=='control.json'&&!body.key.startsWith('probes/')&&!create))return json({error:'PRECONDITION_REQUIRED'},400);
    const object=await env.JOURNAL.put(body.key,body.value,{onlyIf:create?{etagDoesNotMatch:'*'}:{etagMatches:body.ifMatch}});
    return object?json({etag:object.etag}):json({conflict:true},412);
  }catch{return json({error:'OPERATOR_STORAGE_FAILED'},503);}
}};
