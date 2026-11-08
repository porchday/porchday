/** Device-local drafts: only signed/encrypted metadata and authenticated media
 * chunks reach IndexedDB. A compare-and-swap head prevents cross-tab lost updates. */
const database = 'porchday-encrypted-post-drafts-v1';
const chunkSize = 1024 * 1024;
export type DraftFile = {id:string;key:string;iv:string;size:number;chunks:number;type:string;name:string};
type Head = {revision:string;sealed:unknown|null};
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
const decode=(value:string)=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
async function db(){return new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(database,1);r.onupgradeneeded=()=>r.result.createObjectStore('drafts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('Draft storage is unavailable.'));});}
async function transaction<T>(mode:IDBTransactionMode,run:(store:IDBObjectStore,done:(result:T)=>void)=>void){const d=await db();try{return await new Promise<T>((resolve,reject)=>{const tx=d.transaction('drafts',mode);let result:T;tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error||Error('Draft could not be saved.'));try{run(tx.objectStore('drafts'),value=>{result=value;});}catch(error){tx.abort();reject(error);}});}finally{d.close();}}
const get=<T>(key:string)=>transaction<T|undefined>('readonly',(s,done)=>{const r=s.get(key);r.onsuccess=()=>done(r.result);});
const put=(key:string,value:unknown)=>transaction<void>('readwrite',(s,done)=>{s.put(value,key);done();});
export class PostDraftStore {
 private revision:string|null=null;
 private files=new WeakMap<Blob,DraftFile>();
 readonly prefix:string;
 constructor(owner:string,scope:string){this.prefix=encodeURIComponent(owner)+'/'+encodeURIComponent(scope)+'/';}
 async load(){const head=await get<Head>(this.prefix+'head');this.revision=head?.revision??null;return head?.sealed??null;}
 async file(blob:Blob,name:string):Promise<DraftFile>{
  const known=this.files.get(blob);if(known)return known;
  if(blob.size>1024*1024*1024)throw Error('This file is too large to save as a draft.');
  const id=crypto.randomUUID(),raw=crypto.getRandomValues(new Uint8Array(32)),nonce=crypto.getRandomValues(new Uint8Array(8));
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
  const item={id,key:encode(raw),iv:encode(nonce),size:blob.size,chunks:Math.ceil(blob.size/chunkSize),type:blob.type,name};raw.fill(0);
  for(let i=0;i<item.chunks;i++){
   const iv=new Uint8Array(12);iv.set(nonce);new DataView(iv.buffer).setUint32(8,i);
   const plain=new Uint8Array(await blob.slice(i*chunkSize,(i+1)*chunkSize).arrayBuffer());
   try{const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(this.prefix+id+'/'+i)},key,plain);await put(this.prefix+'file/'+id+'/'+i,encrypted);}finally{plain.fill(0);}
  }
  this.files.set(blob,item);return item;
 }
 async readFile(item:DraftFile){
  if(!/^[a-f0-9-]{36}$/.test(item.id)||!Number.isSafeInteger(item.size)||item.size<0||item.size>1024*1024*1024||item.chunks!==Math.ceil(item.size/chunkSize))throw Error('Saved draft media is invalid.');
  const key=await crypto.subtle.importKey('raw',decode(item.key),'AES-GCM',false,['decrypt']),nonce=decode(item.iv),parts:BlobPart[]=[];
  if(nonce.length!==8)throw Error('Saved draft media is invalid.');
  for(let i=0;i<item.chunks;i++){
   const encrypted=await get<ArrayBuffer>(this.prefix+'file/'+item.id+'/'+i);if(!encrypted)throw Error('A saved draft attachment is missing.');
   const iv=new Uint8Array(12);iv.set(nonce);new DataView(iv.buffer).setUint32(8,i);
   const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(this.prefix+item.id+'/'+i)},key,encrypted);
   if(plain.byteLength!==Math.min(chunkSize,item.size-i*chunkSize))throw Error('Saved draft media is incomplete.');parts.push(plain);
  }
  const file=new File(parts,item.name,{type:item.type});this.files.set(file,item);return file;
 }
 async commit(sealed:unknown|null,files:DraftFile[]){
  const expected=this.revision,next=crypto.randomUUID(),prefix=this.prefix,keep=new Set(files.map(f=>f.id));let conflict=false,failure:unknown;
  try{await transaction<void>('readwrite',(s,done)=>{const r=s.get(prefix+'head');r.onsuccess=()=>{try{
   if((r.result?.revision??null)!==expected){conflict=true;s.transaction.abort();return;}
   s.put({revision:next,sealed},prefix+'head');
   const cursor=s.openCursor(IDBKeyRange.bound(prefix+'file/',prefix+'file/\uffff'));cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;const id=String(c.key).slice((prefix+'file/').length).split('/')[0];try{if(!keep.has(id))c.delete();c.continue();}catch(e){failure=e;s.transaction.abort();}};done();
  }catch(e){failure=e;s.transaction.abort();}};});}catch(error){if(conflict)throw Error('This draft changed in another tab. Keep this tab open and finish editing in the other tab.');throw failure||error;}
  this.revision=next;
 }
}
