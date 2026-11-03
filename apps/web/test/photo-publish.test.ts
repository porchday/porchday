import {photoBytesHash} from "@porchday/crypto/photos";
import {generateDeviceKeys,unlockPrivateKey} from "@porchday/crypto";
import {beforeAll,beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("../src/api",async importOriginal=>({...await importOriginal<typeof import("../src/api")>(),get:vi.fn(),post:vi.fn(),request:vi.fn()}));
import {ApiError,get,post,request} from "../src/api";
import {publishPhoto,localPhotoDate,type PhotoDraft} from "../src/photo-publish";
vi.mock("../src/photo-record",()=>({openPhoto:vi.fn(async(_vault,_photo,grant)=>grant.envelope.payload)}));
let sourceHash:string;
const draft:PhotoDraft={id:"photo-id",name:"day.jpg",alt:"A day outside",blob:new Blob(["synthetic image bytes"]),width:1,height:1,photoDate:"2026-10-31"};
const vault={member:{id:"owner"},device:{id:"device"},seal:vi.fn(async(payload,context)=>({context,payload})),open:vi.fn(async(row)=>row.envelope.payload)} as any;
function saved(audience="connections",album:string|null=null){return {photo:{owner_id:"owner",photo_date:draft.photoDate,expires_at:null,grants:[{id:"direct",album_id:null,audience,envelope:{payload:{photoProof:{statement:{sha256:sourceHash}},media:[{alt:draft.alt,tags:[]}]}}},...(album?[{id:"album",album_id:album,audience:"album",envelope:{payload:{photoProof:{statement:{sha256:sourceHash}},media:[{alt:draft.alt,tags:[]}]}}}]:[])]}};}
beforeAll(async()=>{sourceHash=await photoBytesHash(new Uint8Array(await draft.blob.arrayBuffer()));const keys=await generateDeviceKeys("owner","device");vault.privateKey=await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret);});
beforeEach(()=>{vi.clearAllMocks();vi.mocked(get).mockRejectedValue(new ApiError(404,{error:{code:"NOT_FOUND"}}));vi.mocked(post).mockImplementation(async(path)=>path==="/media"?{upload_url:"/media/upload"}:{id:draft.id});vi.mocked(request).mockResolvedValue({ok:true});});
describe("independent photo publication",()=>{
 it("publishes one logical photo with distinct direct and album media grants and no post",async()=>{
  await publishPhoto(vault,draft,"connections",null,"album-id");
  expect(vi.mocked(post).mock.calls.filter(([path])=>path==="/media")).toHaveLength(2);
  const publications=vi.mocked(post).mock.calls.filter(([path])=>path==="/photos");expect(publications).toHaveLength(1);
  const body=publications[0][1] as any;expect(body.id).toBe(draft.id);expect(body.photo_date).toBe(draft.photoDate);
  expect(body.grants.map((g:any)=>g.envelope.context.audience)).toEqual(["connections","album"]);
  expect(body.grants[0].media_id).not.toBe(body.grants[1].media_id);
  expect(vi.mocked(post).mock.calls.some(([path])=>path==="/posts")).toBe(false);
 });
 it("reconciles a lost publication response without repeating the committed write",async()=>{
  vi.mocked(get).mockRejectedValueOnce(new ApiError(404,{error:{code:"NOT_FOUND"}})).mockResolvedValueOnce(saved());
  vi.mocked(post).mockImplementation(async(path)=>{if(path==="/photos")throw Error("Response lost");return {upload_url:"/media/upload"};});
  await expect(publishPhoto(vault,draft,"connections",null,null)).resolves.toBeUndefined();
  expect(vi.mocked(post).mock.calls.filter(([path])=>path==="/photos")).toHaveLength(1);
 });
 it("rejects a different photo using the same stable identity",async()=>{
  vi.mocked(get).mockResolvedValue(saved());
  await expect(publishPhoto(vault,{...draft,blob:new Blob(["different bytes"])},"connections",null,null)).rejects.toThrow(/already shared/);
  expect(post).not.toHaveBeenCalled();
 });
 it("checks the stable ID before uploading again and refuses silently changed audiences or captions",async()=>{
  vi.mocked(get).mockResolvedValue(saved());
  await publishPhoto(vault,draft,"connections",null,null);expect(post).not.toHaveBeenCalled();
  await expect(publishPhoto(vault,draft,"only_me",null,null)).rejects.toThrow(/different audience/);
  await expect(publishPhoto(vault,{...draft,alt:"Changed"},"connections",null,null)).rejects.toThrow(/already shared/);
  await expect(publishPhoto(vault,draft,"connections",null,"new-album")).rejects.toThrow(/different audience/);
  expect(post).not.toHaveBeenCalled();
 });
 it("does not publish when media upload fails, and propagates unknown reconciliation outcomes",async()=>{
  vi.mocked(request).mockRejectedValueOnce(Error("Upload interrupted"));
  await expect(publishPhoto(vault,draft,"connections",null,null)).rejects.toThrow(/Upload interrupted/);
  expect(vi.mocked(post).mock.calls.some(([path])=>path==="/photos")).toBe(false);
  vi.mocked(get).mockRejectedValueOnce(Error("Offline"));
  await expect(publishPhoto(vault,draft,"connections",null,null)).rejects.toThrow(/Offline/);
 });
 it("uses the local calendar day rather than converting it to UTC",()=>{const date=new Date(2026,0,2,0,15);expect(localPhotoDate(date)).toBe("2026-01-02");});
});
