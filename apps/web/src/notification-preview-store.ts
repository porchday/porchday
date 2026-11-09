import type {PreviewIdentity} from '../../../packages/crypto/src/notification-preview';
export type StoredPreviewKey={identity:PreviewIdentity;privateKey:CryptoKey;pins?:Record<string,string>};
const name='porchday-notification-keys-v1';let generation=0;
async function store<T>(mode:IDBTransactionMode,work:(s:IDBObjectStore)=>IDBRequest<T>):Promise<T>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('keys',{keyPath:'identity.keyId'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('NOTIFICATION_STORAGE_UNAVAILABLE'));});try{return await new Promise<T>((resolve,reject)=>{const tx=db.transaction('keys',mode),r=work(tx.objectStore('keys'));tx.oncomplete=()=>resolve(r.result);tx.onerror=tx.onabort=()=>reject(Error('NOTIFICATION_STORAGE_UNAVAILABLE'));});}finally{db.close();}}
export async function storedPreviewKeys(){return store('readonly',s=>s.getAll()) as Promise<StoredPreviewKey[]>;}
export function previewGeneration(){return generation;}
export async function savePreviewKey(row:StoredPreviewKey,expected:number){if(generation!==expected)throw Error('PREVIEW_ENROLLMENT_CANCELLED');await store('readwrite',s=>{if(generation!==expected)throw Error('PREVIEW_ENROLLMENT_CANCELLED');return s.put(row);});}
export async function clearPreviewKeys(){generation++;await store('readwrite',s=>s.clear());}
