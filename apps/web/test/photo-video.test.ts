import {beforeEach,it,expect,vi} from 'vitest';
import {generateDeviceKeys,unlockPrivateKey,encryptObject,decryptObject} from '@porchday/crypto';
import {verifyPhotoProof,photoMetadata} from '@porchday/crypto/photos';
vi.mock('../src/api',async original=>({...await original<typeof import('../src/api')>(),request:vi.fn(),get:vi.fn(),post:vi.fn(),del:vi.fn()}));
import {request,ApiError} from '../src/api';
import {stagePhotoVideo,verifyPhotoVideo} from '../src/photo-video';
import {pendingPublications,sendPublication,hasSavedPublication} from '../src/video-outbox';
class Directory{
 kind='directory';entriesMap=new Map<string,Directory|Blob>();
 async getDirectoryHandle(name:string,options?:{create?:boolean}){if(!this.entriesMap.has(name)&&options?.create)this.entriesMap.set(name,new Directory());const entry=this.entriesMap.get(name);if(!(entry instanceof Directory))throw new DOMException('Missing','NotFoundError');return entry;}
 async getFileHandle(name:string,options?:{create?:boolean}){if(!this.entriesMap.has(name)&&options?.create)this.entriesMap.set(name,new Blob());if(!this.entriesMap.has(name))throw new DOMException('Missing','NotFoundError');return{getFile:async()=>this.entriesMap.get(name) as Blob,createWritable:async()=>({write:async(data:Blob|string)=>{this.entriesMap.set(name,data instanceof Blob?data:new Blob([data]));},close:async()=>{},abort:async()=>{}})};}
 async removeEntry(name:string){this.entriesMap.delete(name);}
 async *entries(){for(const[name,value]of this.entriesMap)yield[name,value];}
}
let root:Directory;
beforeEach(()=>{vi.clearAllMocks();root=new Directory();vi.stubGlobal('navigator',{storage:{getDirectory:async()=>root}});});
async function setup(){
 const owner=crypto.randomUUID(),device=crypto.randomUUID(),id=crypto.randomUUID(),keys=await generateDeviceKeys(owner,device),key=await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret);
 const vault={member:{id:owner},device:{id:device},privateKey:key,seal:async(payload:any,context:any)=>encryptObject({payload,context:{revision:1,epoch:1,authorId:owner,authorDeviceId:device,...context},signingKey:key,recipients:[{memberId:owner,deviceId:device,publicKey:keys.publicKey}]})} as any;
 const blob=new Blob(['synthetic video contents']),prepared={blob,width:640,height:480,duration:1,mime:'video/mp4',dispose:vi.fn(),preview:''} as any;
 const draft={id,name:'clip.mp4',alt:'Full recording',blob,width:640,height:480,mime:'video/mp4',photoDate:'2026-11-01'};
 const open=async(envelope:any)=>decryptObject<any>({envelope,expectedContext:envelope.context,privateKey:key,authorPublicKey:keys.publicKey});
 return{owner,device,id,keys,vault,prepared,draft,open};
}
it('durably shares a direct video to two audiences using one encrypted stream, verifies its owner binding, and reconciles a lost final response',async()=>{
 const s=await setup(),signal=new AbortController().signal;
 await stagePhotoVideo(s.vault,s.draft,s.prepared,'connections',null,crypto.randomUUID(),signal);
 expect(await pendingPublications(s.owner)).toMatchObject([{id:s.id}]);
 const dir=await(await root.getDirectoryHandle('porchday-encrypted-video-outbox')).getDirectoryHandle(s.owner),operation=await dir.getDirectoryHandle(s.id);
 const saved=JSON.parse(await(await(await operation.getFileHandle('publication.json')).getFile()).text());
 expect(saved.kind).toBe('photo');expect(saved.media).toHaveLength(2);expect(saved.media[0].stream_id).toBe(saved.media[1].stream_id);
 expect(JSON.stringify(saved)).not.toContain('synthetic video contents');expect(JSON.stringify(saved)).not.toContain('Full recording');
 const first=saved.post.grants[0],content=await s.open(first.envelope),mediaEnvelope=JSON.parse(await(await(await operation.getFileHandle(first.media_id)).getFile()).text()),payload=await s.open(mediaEnvelope);
 expect(content.media[0].videoVersion).toBe(3);
 await verifyPhotoProof(content.photoProof,{photoId:s.id,ownerId:s.owner,deviceId:s.device,revision:1,date:s.draft.photoDate,expiresAt:null,metadata:photoMetadata(content.media[0])},s.keys.publicKey);
 await expect(verifyPhotoVideo(content.photoProof,payload.video)).resolves.toMatchObject({streamId:saved.media[0].stream_id});
 await expect(verifyPhotoVideo(content.photoProof,{...payload.video,key:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='})).rejects.toThrow();
 let published:any,received=false,chunks=0,publications=0;
 vi.mocked(request).mockImplementation(async(path,options:any)=>{
  if(path==='/photos/'+s.id){if(published)return{photo:published};throw new ApiError(404,{error:{code:'NOT_FOUND'}});}
  if(path==='/videos')return{upload_url:'/media/'+JSON.parse(options.body).id+'/bytes',state:'pending'};
  if(path.endsWith('/status'))return{received:received?[0]:[]};
  if(path.includes('/chunks/')){received=true;chunks++;return{};}
  if(path.endsWith('/complete')||path.endsWith('/bytes'))return{};
  if(path==='/photos'){publications++;const b=JSON.parse(options.body);published={owner_id:s.owner,photo_date:b.photo_date,expires_at:b.expires_at,grants:b.grants.map((g:any)=>({id:g.envelope.context.id,...g}))};throw Error('Response lost');}
  throw Error('Unexpected '+path);
 });
 await expect(sendPublication(s.owner,s.id,signal)).rejects.toThrow('Response lost');
 expect(await hasSavedPublication(s.owner,s.id)).toBe(true);expect(chunks).toBe(1);
 await sendPublication(s.owner,s.id,signal);expect(publications).toBe(1);expect(await pendingPublications(s.owner)).toEqual([]);
 expect(vi.mocked(request).mock.calls.some(([path])=>path==='/posts')).toBe(false);
});
it('preserves saved ciphertext when a second attempt uses the same identity and cleans aborted preparation',async()=>{
 const s=await setup();await stagePhotoVideo(s.vault,s.draft,s.prepared,'only_me',null,null,new AbortController().signal);
 await expect(stagePhotoVideo(s.vault,s.draft,s.prepared,'connections',null,null,new AbortController().signal)).rejects.toThrow(/saved encrypted upload/);
 expect(await hasSavedPublication(s.owner,s.id)).toBe(true);
 const other={...s.draft,id:crypto.randomUUID()},abort=new AbortController();abort.abort();
 await expect(stagePhotoVideo(s.vault,other,s.prepared,'only_me',null,null,abort.signal)).rejects.toThrow();
 expect(await hasSavedPublication(s.owner,other.id)).toBe(false);
});
