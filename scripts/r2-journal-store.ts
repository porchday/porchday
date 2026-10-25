import type {JournalStore} from '../apps/api/src/privacy-journal.js';

type Conditional = {onlyIf?: {etagMatches?: string; etagDoesNotMatch?: string}};
type Options = {accountId: string; apiToken: string; bucket: string; fetch?: typeof fetch};

/** Private operator adapter. Never logs credentials, object bodies or URLs. */
export class R2JournalStore implements JournalStore {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly bucket: string;
  private readonly request: typeof fetch;
  constructor(options: Options) {
    if (!/^[a-f0-9]{32}$/i.test(options.accountId) || !options.apiToken || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new Error('R2_OPERATOR_CONFIGURATION_INVALID');
    }
    this.accountId=options.accountId; this.apiToken=options.apiToken; this.bucket=options.bucket; this.request=options.fetch ?? fetch;
  }
  static fromEnvironment(bucket: string) {
    return new R2JournalStore({accountId:process.env.CLOUDFLARE_ACCOUNT_ID ?? '',apiToken:process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? '',bucket});
  }
  private async send(method: string, key: string, body?: string, condition?: Conditional): Promise<Response> {
    if (!key || key.length>1024 || key.split('/').some(part=>part==='.' || part==='..') || /[\x00-\x1f\x7f]/.test(key)) throw new Error('R2_OBJECT_KEY_INVALID');
    const path=key.split('/').map(encodeURIComponent).join('/');
    const headers=new Headers({Authorization:'Bearer '+this.apiToken});
    if (body!==undefined) headers.set('Content-Type','application/json');
    if (condition?.onlyIf?.etagMatches) headers.set('If-Match',quoteETag(condition.onlyIf.etagMatches));
    if (condition?.onlyIf?.etagDoesNotMatch) headers.set('If-None-Match',condition.onlyIf.etagDoesNotMatch==='*' ? '*' : quoteETag(condition.onlyIf.etagDoesNotMatch));
    try {
      return await this.request(`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/r2/buckets/${this.bucket}/objects/${path}`,{
        method,headers,body,redirect:'error',signal:AbortSignal.timeout(30_000),
      });
    } catch { throw new Error('R2_OPERATOR_REQUEST_FAILED'); }
  }
  async get(key: string): Promise<{etag:string;text():Promise<string>}|null> {
    const response=await this.send('GET',key);
    if(response.status===404)return null;
    if(!response.ok)throw new Error('R2_OPERATOR_READ_FAILED');
    const etag=readETag(response);
    return {etag,text:()=>response.text()};
  }
  async put(key: string,value: string,options?: Conditional): Promise<{etag:string}|null> {
    const response=await this.send('PUT',key,value,options);
    if(response.status===412)return null;
    if(!response.ok)throw new Error('R2_OPERATOR_WRITE_FAILED');
    // Cloudflare's REST write returns the atomic result ETag in JSON metadata;
    // R2 object GET uses the HTTP ETag header. Never substitute a later GET.
    if(response.headers.has('etag'))return {etag:readETag(response)};
    let result:unknown;
    try {result=await response.json();} catch {throw new Error('R2_STRONG_ETAG_REQUIRED');}
    const metadata=result as {success?:boolean;result?:{etag?:unknown}};
    if(metadata.success!==true || typeof metadata.result?.etag!=='string')throw new Error('R2_STRONG_ETAG_REQUIRED');
    const etag=metadata.result.etag;
    if(etag.startsWith('W/'))throw new Error('R2_STRONG_ETAG_REQUIRED');
    return {etag:quoteETag(etag).slice(1,-1)};
  }
  async deleteMediaObject(key: string): Promise<void> {
    if(!key.startsWith('media/'))throw new Error('R2_MEDIA_KEY_INVALID');
    await this.remove(key);
  }
  private async remove(key:string):Promise<void> {
    const response=await this.send('DELETE',key);
    if(!response.ok && response.status!==404)throw new Error('R2_OPERATOR_DELETE_FAILED');
  }
  /** Must pass against the actual REST endpoint before any journal control write. */
  async verifyConditionalWrites():Promise<void> {
    const key='probes/'+crypto.randomUUID()+'.json',one='{"probe":1}',two='{"probe":2}';
    try {
      const first=await this.put(key,one,{onlyIf:{etagDoesNotMatch:'*'}});
      if(!first)throw new Error('R2_CONDITIONAL_WRITES_UNVERIFIED');
      if(await this.put(key,two,{onlyIf:{etagDoesNotMatch:'*'}}))throw new Error('R2_CONDITIONAL_WRITES_UNSUPPORTED');
      const before=await this.get(key);
      if(!before || before.etag!==first.etag || await before.text()!==one)throw new Error('R2_CONDITIONAL_WRITES_UNVERIFIED');
      const second=await this.put(key,two,{onlyIf:{etagMatches:first.etag}});
      if(!second || second.etag===first.etag)throw new Error('R2_CONDITIONAL_WRITES_UNVERIFIED');
      if(await this.put(key,one,{onlyIf:{etagMatches:first.etag}}))throw new Error('R2_CONDITIONAL_WRITES_UNSUPPORTED');
      const after=await this.get(key);
      if(!after || after.etag!==second.etag || await after.text()!==two)throw new Error('R2_CONDITIONAL_WRITES_UNVERIFIED');
    } finally { await this.remove(key); }
  }
}
function readETag(response:Response):string {
  const value=response.headers.get('etag');
  if(!value || value.startsWith('W/'))throw new Error('R2_STRONG_ETAG_REQUIRED');
  const raw=value.startsWith('"') && value.endsWith('"') ? value.slice(1,-1) : value;
  quoteETag(raw);return raw;
}
function quoteETag(value:string):string {
  const raw=value.startsWith('"') && value.endsWith('"') ? value.slice(1,-1) : value;
  if(!raw || /[\x00-\x20\x7f"\\]/.test(raw) || raw==='*')throw new Error('R2_STRONG_ETAG_REQUIRED');
  return '"'+raw+'"';
}
