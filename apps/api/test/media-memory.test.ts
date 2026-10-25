import {createHash} from 'node:crypto';
import {afterEach,expect,test,vi} from 'vitest';
import {canonicalJson,type EncryptedEnvelope} from '@porchday/crypto';
import {envelopeDigest,limitedMediaBody,parseMediaJson,streamPendingMedia,uploadMetadata,withMediaMemoryPermit} from '../src/social-media';
import {app} from '../src/index';
import type {Env} from '../src/types';
import * as authentication from '../src/auth';

const envelope=(ciphertext:string)=>({v:1,protocol:'porchday-openpgp-v1',context:{id:'synthetic',kind:'media',authorId:'member',authorDeviceId:'device',audience:'only_me',parentId:'parent',groupId:null,epoch:1,createdAt:'2026-10-25T00:00:00.000Z',expiresAt:null,revision:1},recipients:[{memberId:'member',deviceId:'device',fingerprint:'f'.repeat(64)}],ciphertext}) as EncryptedEnvelope;
const fail=(code:string)=>{throw Error(code);};
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

test('bounded native hashing exactly preserves canonical envelope digests across JSON escapes and UTF-16 chunk boundaries',async()=>{
 for(const ciphertext of ['', '-----BEGIN PGP MESSAGE-----\r\nquoted"\\\t\u0000\u001f\u2028\u2029🌻',
  'a'.repeat(16383)+'🌻'+'b'.repeat(16384),
  'a'.repeat(16384)+'\ud800'+'b'.repeat(16384)+'\udfff',
  'a'.repeat(16383)+'\ud800x\udfff'+'😀'.repeat(16384)]){
  const value=envelope(ciphertext),reference=createHash('sha256').update(canonicalJson(value)).digest('hex');
  expect(await envelopeDigest(value)).toBe(reference);
  const reordered={recipients:value.recipients,context:value.context,ciphertext:value.ciphertext,protocol:value.protocol,v:value.v};
  expect(await envelopeDigest(reordered)).toBe(reference);
 }
});

test('streamed body cap verifies actual bytes despite absent or dishonest Content-Length and cancels overflow',async()=>{
 for(const headers of [{},{'Content-Length':'1'}]){
  const cancel=vi.fn();let count=0;
  const stream=new ReadableStream<Uint8Array>({pull(controller){count++;controller.enqueue(new Uint8Array(8));},cancel});
  const request=new Request('https://example.test/media',{method:'PUT',headers,body:stream,duplex:'half'} as RequestInit);
  await expect(limitedMediaBody(request,16,fail).arrayBuffer()).rejects.toThrow('PAYLOAD_TOO_LARGE');
  await Promise.resolve();expect(cancel).toHaveBeenCalled();expect(count).toBeLessThan(8);
 }
 expect(()=>limitedMediaBody(new Request('https://example.test/media',{method:'PUT',headers:{'Content-Length':'17'},body:'small'}),16,fail)).toThrow('PAYLOAD_TOO_LARGE');
});

test('streamed body reader preserves exact valid bytes and JSON without caching them in the application context',async()=>{
 const bytes=new Uint8Array([0,1,2,128,255]),request=new Request('https://example.test/media',{method:'PUT',body:bytes});
 expect(new Uint8Array(await limitedMediaBody(request,5,fail).arrayBuffer())).toEqual(bytes);
 const json=new Request('https://example.test/media',{method:'POST',body:JSON.stringify({alt:'🌻'})});
 expect(await limitedMediaBody(json,20,fail).json()).toEqual({alt:'🌻'});
});

const chunked=(bytes:Uint8Array,size:number,cancel?:()=>void)=>{let offset=0;return new ReadableStream<Uint8Array>({pull(controller){if(offset>=bytes.length){controller.close();return;}controller.enqueue(bytes.subarray(offset,offset+size));offset+=size;},cancel},{highWaterMark:0});};
test('bounded streaming JSON matches JSON.parse for BOM, duplicate keys, Unicode, fragmented escapes and surrogates',async()=>{
 const texts=[JSON.stringify(envelope('-----BEGIN PGP MESSAGE-----\r\n🌻é漢字"\\\t\u0000\u2028\u2029')),
  '{"value":"\\ud800x\\udfff","pair":"\\ud83c\\udf3b"}',
  '{"value":"old","value":"new","__proto__":{"safe":true},"constructor":1}',
  '\ufeff{"value":"BOM"} \r\n\t',
  JSON.stringify({value:'\ufeff'+('a'.repeat(65536))+'\ufeff',other:'\\\ufeff',key:'\ufeff'}),
  '{"'+('k'.repeat(65536))+'\ufeff":"'+('a'.repeat(65536))+'\ufeff"}',
  '{"value":"'+('é🌻x'.repeat(20_000))+'"}',
  '{"value":-12.34e+5,"null":null,"array":[true,false,0,1e999]}'];
 for(const source of texts){const bytes=new TextEncoder().encode(source),reference=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  for(const size of [1,2,3,7,16384,65536]){
   const result=await parseMediaJson(chunked(bytes,size),bytes.length,fail);expect(result).toEqual(reference);
   if(source.includes('__proto__')){expect(Object.hasOwn(result as object,'__proto__')).toBe(true);expect(Object.getPrototypeOf(result)).toBe(Object.prototype);}
  }
 }
},20_000);

test('streaming JSON rejects malformed input with fixed errors and cancels excessive depth, breadth and actual bytes',async()=>{
 for(const source of ['', '{', '{}{}','{} trailing','{"x":1,}','{"x":"bad\nline"}','{"x":"\\u12"}','[1,,2]','\ufeff\ufeff{}',' \ufeff{}']){
  await expect(parseMediaJson(chunked(new TextEncoder().encode(source),1),1000,fail),JSON.stringify(source)).rejects.toThrow('INVALID_MEDIA_ENVELOPE');
 }
 for(const bytes of [new Uint8Array([0xff]),new Uint8Array([34,0xc0,0xaf,34]),new Uint8Array([34,0xe2,0x82,34]),new Uint8Array([34,0xed,0xa0,0x80,34])])
  await expect(parseMediaJson(chunked(bytes,1),1000,fail)).rejects.toThrow('INVALID_MEDIA_ENVELOPE');
 for(const source of ['['.repeat(17)+'0'+']'.repeat(17),'['+'0,'.repeat(50_001)+'0]']){
  const cancel=vi.fn();await expect(parseMediaJson(chunked(new TextEncoder().encode(source),8,cancel),1_000_000,fail)).rejects.toThrow('INVALID_MEDIA_ENVELOPE');expect(cancel).toHaveBeenCalled();
 }
 const cancel=vi.fn();await expect(parseMediaJson(chunked(new TextEncoder().encode('{"value":"'+('a'.repeat(100))+'"}'),8,cancel),16,fail)).rejects.toThrow('PAYLOAD_TOO_LARGE');expect(cancel).toHaveBeenCalled();
 const request=new Request('https://test/media',{method:'POST',body:'{"value":"'+('a'.repeat(100))+'"}'});
 await expect(parseMediaJson(limitedMediaBody(request,16,fail).body,16,fail)).rejects.toThrow('PAYLOAD_TOO_LARGE');
 // A huge single number uses the parser's bounded number buffer as well.
 expect(await parseMediaJson(chunked(new TextEncoder().encode('['+'9'.repeat(200_000)+']'),7),250_000,fail)).toEqual([Infinity]);
});

test('large escaped surrogate tokens preserve code units without per-character retained string nodes',async()=>{
 for(const pattern of ['\\ud800','\\udfff','x\\ud800','\\ud800\\udfff']){
  const source='{"value":"'+pattern.repeat(200_000)+'"}',bytes=new TextEncoder().encode(source);
  expect(await parseMediaJson(chunked(bytes,65536),bytes.length,fail)).toEqual(JSON.parse(source));
 }
});

test('unauthorized media requests are rejected before an unknown-length upload is read',async()=>{
 for(const [method,path] of [['POST','/api/v1/media'],['PUT','/api/v1/media/12345678-1234-1234-1234-123456789abc/bytes']]){
  const pull=vi.fn((controller:ReadableStreamDefaultController<Uint8Array>)=>{controller.enqueue(new Uint8Array(1024));});
  const body=new ReadableStream<Uint8Array>({pull},{highWaterMark:0});
  const request=new Request('https://porchday.test'+path,{method,headers:{Origin:'https://wrong.example'},body,duplex:'half'} as RequestInit);
  const response=await app.fetch(request,{ENVIRONMENT:'production',APP_URL:'https://porchday.test'} as Env);
  expect(response.status).toBe(403);expect(pull).not.toHaveBeenCalled();await body.cancel();
 }
});

test('valid-origin media requests with no session are rejected before reading unknown-length bodies',async()=>{
 const logs=vi.spyOn(console,'log').mockImplementation(()=>{});
 // Session verification itself is covered by the database-backed auth suite;
 // this exercises the real request middleware with an unauthenticated result.
 vi.spyOn(authentication,'createAuth').mockReturnValue({api:{getSession:async()=>null}} as never);
 for(const [method,path] of [['POST','/api/v1/media'],['PUT','/api/v1/media/12345678-1234-1234-1234-123456789abc/bytes']]){
  const pull=vi.fn((controller:ReadableStreamDefaultController<Uint8Array>)=>controller.enqueue(new Uint8Array(1024)));
  const body=new ReadableStream<Uint8Array>({pull},{highWaterMark:0}),pending:Promise<unknown>[]=[];
  const request=new Request('https://porchday.test'+path,{method,headers:{Origin:'https://porchday.test'},body,duplex:'half'} as RequestInit);
  const env={ENVIRONMENT:'development',APP_URL:'https://porchday.test',BETTER_AUTH_SECRET:'synthetic-test-secret-at-least-thirty-two-characters',HYPERDRIVE_AUTH:{connectionString:'postgres://unused:unused@127.0.0.1:1/unused'}} as Env;
  const response=await app.fetch(request,env,{waitUntil:p=>{pending.push(p);},passThroughOnException(){},props:{}} as ExecutionContext);
  expect(response.status).toBe(401);expect(pull).not.toHaveBeenCalled();await body.cancel();await Promise.all(pending);
 }
 logs.mockRestore();
});

test('pending storage streams exact bytes with UTF-8 validation, a raw digest and create-only ownership',async()=>{
 const bytes=new TextEncoder().encode('{"name":"🌻"}'),stored:Uint8Array[]=[];
 const bucket={put:vi.fn(async(_key:string,body:ReadableStream,options:unknown)=>{expect(options).toMatchObject({onlyIf:{etagDoesNotMatch:'*'}});stored.push(new Uint8Array(await new Response(body).arrayBuffer()));return {etag:'owned'};})} as unknown as R2Bucket;
 const written=vi.fn(),request=new Request('https://test/media',{method:'PUT',body:bytes});
 expect(await streamPendingMedia(request,bucket,'media/synthetic/id',bytes.length,Date.now()+1000,fail,written)).toBe(createHash('sha256').update(bytes).digest('hex'));expect(stored[0]).toEqual(bytes);expect(written).toHaveBeenCalledExactlyOnceWith('owned');
 const collision={put:async()=>null} as unknown as R2Bucket;
 await expect(streamPendingMedia(new Request('https://test/media',{method:'PUT',body:bytes}),collision,'media/synthetic/id',bytes.length,Date.now()+1000,fail,vi.fn())).rejects.toThrow('MEDIA_UPLOAD_IN_PROGRESS');
 await expect(streamPendingMedia(new Request('https://test/media',{method:'PUT',body:new Uint8Array([255])}),bucket,'media/synthetic/id',1,Date.now()+1000,fail,vi.fn())).rejects.toThrow('INVALID_MEDIA_ENVELOPE');
 await expect(streamPendingMedia(new Request('https://test/media',{method:'PUT',body:bytes}),bucket,'media/synthetic/id',bytes.length-1,Date.now()+1000,fail,vi.fn())).rejects.toThrow('MEDIA_UPLOAD_MISMATCH');
});

test('upload timeout cancels the stream consumed by storage, rather than only returning early',async()=>{
 vi.useFakeTimers();const cancel=vi.fn(),written=vi.fn();
 const body=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});},cancel});
 const bucket={put:async(_key:string,stream:ReadableStream)=>{await new Response(stream).arrayBuffer();return {etag:'never-written'};}} as unknown as R2Bucket;
 const pending=streamPendingMedia(new Request('https://test/media',{method:'PUT',body,duplex:'half'} as RequestInit),bucket,'media/synthetic/id',10,Date.now()+100,fail,written);
 const assertion=expect(pending).rejects.toThrow('MEDIA_UPLOAD_EXPIRED');await vi.advanceTimersByTimeAsync(101);await assertion;expect(cancel).toHaveBeenCalled();expect(written).not.toHaveBeenCalled();
});

test('metadata validation cancels a stalled R2 read and releases the parsing permit at the same upload deadline',async()=>{
 vi.useFakeTimers();const cancel=vi.fn(),body=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});},cancel});
 const pending=withMediaMemoryPermit(()=>uploadMetadata({body},Date.now()+100,fail),()=>fail('MEDIA_BUSY'));
 const assertion=expect(pending).rejects.toThrow('MEDIA_UPLOAD_EXPIRED');await vi.advanceTimersByTimeAsync(101);await assertion;
 expect(cancel).toHaveBeenCalled();expect(body.locked).toBe(false);
 await expect(withMediaMemoryPermit(async()=>42,()=>fail('MEDIA_BUSY'))).resolves.toBe(42);
});

test('the per-isolate memory permit rejects concurrent large parses without waiting or invoking their readers',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const first=withMediaMemoryPermit(()=>gate,()=>fail('MEDIA_BUSY')),second=vi.fn(async()=>{});
 await expect(withMediaMemoryPermit(second,()=>fail('MEDIA_BUSY'))).rejects.toThrow('MEDIA_BUSY');expect(second).not.toHaveBeenCalled();release();await first;
 await expect(withMediaMemoryPermit(async()=>{throw Error('validation');},()=>fail('MEDIA_BUSY'))).rejects.toThrow('validation');
 await expect(withMediaMemoryPermit(async()=>42,()=>fail('MEDIA_BUSY'))).resolves.toBe(42);
});
