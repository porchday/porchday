import {describe,it,expect} from 'vitest';
import {R2JournalStore} from './r2-journal-store.js';
function storage(honorConditions:boolean,etag=true) {
  const data=new Map<string,string>();
  const request:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)),key=url.pathname,headers=new Headers(init?.headers),existing=data.get(key),tag=existing===undefined?undefined:'"'+existing.length+'-'+existing+'"';
    if(init?.method==='DELETE'){data.delete(key);return new Response(null,{status:204});}
    if(init?.method==='GET')return existing===undefined?new Response(null,{status:404}):new Response(existing,{headers:etag?{ETag:'"'+existing.replaceAll('"','').length+'-'+hash(existing)+'"'}:{}});
    const strong=existing===undefined?null:'"'+existing.replaceAll('"','').length+'-'+hash(existing)+'"';
    if(honorConditions && (headers.get('if-none-match')==='*' && existing!==undefined || headers.has('if-match') && headers.get('if-match')!==strong))return new Response(null,{status:412});
    const text=String(init?.body);data.set(key,text);
    return new Response(null,{status:200,headers:etag?{ETag:'"'+text.replaceAll('"','').length+'-'+hash(text)+'"'}:{}});
  };
  return {request,data};
}
const hash=(text:string)=>Array.from(text).reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0).toString(16);
const make=(request:typeof fetch)=>new R2JournalStore({accountId:'a'.repeat(32),apiToken:'synthetic-test-token',bucket:'synthetic-journal',fetch:request});
describe('R2 operator journal conditional capability probe',()=>{
  it('verifies both create-only and compare-and-swap then removes its probe',async()=>{
    const {request,data}=storage(true);await make(request).verifyConditionalWrites();expect(data.size).toBe(0);
  });
  it('fails closed if the endpoint ignores conditions',async()=>{
    const {request,data}=storage(false);await expect(make(request).verifyConditionalWrites()).rejects.toThrow('R2_CONDITIONAL_WRITES_UNSUPPORTED');expect(data.size).toBe(0);
  });
  it('rejects missing entity tags and prevents arbitrary media deletion',async()=>{
    const {request}=storage(true,false),client=make(request);
    await expect(client.put('control.json','{}')).rejects.toThrow('R2_STRONG_ETAG_REQUIRED');
    await expect(client.deleteMediaObject('control.json')).rejects.toThrow('R2_MEDIA_KEY_INVALID');
  });
});
