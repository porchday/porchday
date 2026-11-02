import {beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("../src/api",async original=>({...await original<typeof import("../src/api")>(),get:vi.fn(),post:vi.fn(),request:vi.fn()}));
vi.mock("../src/video",()=>({validatedMedia:vi.fn().mockResolvedValue({})}));
import {get,post,request} from "../src/api";
import {validatedMedia} from "../src/video";
import {addPhotoToAlbum,readOwnedPhoto} from "../src/photo-album";
import type {PhotoRow} from "../src/photo-record";
const metadata={id:"old-media",name:"day.jpg",mime:"image/jpeg",alt:"Caption",width:1,height:1,tags:[]};
function photo():PhotoRow{return {id:"photo",owner_id:"owner",photo_date:"2026-10-31",created_at:"2026-11-01T00:00:00.000Z",expires_at:null,revision:2,grants:[{id:"original-grant",photo_id:"photo",album_id:null,audience:"connections",media_id:"old-media",envelope:{context:{id:"original-grant",kind:"photo",parentId:"photo",photoDate:"2026-10-31",revision:2},payload:{media:[metadata]}} as any}]};}
const source={context:{id:"old-media",kind:"media",parentId:"photo"},payload:{...metadata,bytes:"aGVsbG8="}};
const vault={member:{id:"owner"},open:vi.fn(async(row:any)=>row.envelope.payload),seal:vi.fn(async(payload:any,context:any)=>({payload,context}))} as any;
beforeEach(()=>{vi.clearAllMocks();vi.mocked(get).mockImplementation(async(path)=>path==="/photos/photo"?{photo:photo()}:source as any);vi.mocked(post).mockResolvedValue({upload_url:"/media/upload"});vi.mocked(request).mockResolvedValue({ok:true});});
describe("add existing photo to an album",()=>{
 it("verifies source metadata and bytes, then adds a new album grant without rewriting existing grants",async()=>{
  await addPhotoToAlbum(vault,"photo","album");
  expect(validatedMedia).toHaveBeenCalledWith(new Uint8Array([104,101,108,108,111]),"image/jpeg");
  expect(vi.mocked(post).mock.calls.map(([path])=>path)).toEqual(["/media","/photos/photo/grants"]);
  const added=vi.mocked(post).mock.calls[1][1] as any;
  expect(added.envelope.context).toMatchObject({kind:"photo",parentId:"photo",groupId:"album",audience:"album",photoDate:"2026-10-31",revision:2});
  expect(added.envelope.payload.media[0]).toMatchObject({alt:"Caption",name:"day.jpg"});
  expect(added.media_id).not.toBe("old-media");
  expect(vi.mocked(request).mock.calls[0][1]?.method).toBe("PUT");
 });
 it("denies resharing somebody else's photo before reading its bytes",async()=>{
  await expect(readOwnedPhoto(vault,{...photo(),owner_id:"another-person"})).rejects.toThrow(/Only the photo owner/);
  expect(get).not.toHaveBeenCalled();expect(post).not.toHaveBeenCalled();
 });
 it("does not copy a substituted media resource",async()=>{
  vi.mocked(get).mockResolvedValue({...source,context:{...source.context,parentId:"different-photo"}});
  await expect(readOwnedPhoto(vault,photo())).rejects.toThrow(/do not belong/);
  expect(validatedMedia).not.toHaveBeenCalled();expect(post).not.toHaveBeenCalled();
 });
 it("reconciles an existing album grant before uploading or after an ambiguous response",async()=>{
  const existing=photo();existing.grants.push({...existing.grants[0],id:"album-grant",album_id:"album",audience:"album"});
  vi.mocked(get).mockResolvedValueOnce({photo:existing});
  await addPhotoToAlbum(vault,"photo","album");expect(post).not.toHaveBeenCalled();
  vi.mocked(post).mockImplementation(async(path)=>{if(path.endsWith("/grants")){vi.mocked(get).mockResolvedValueOnce({photo:existing});throw Error("Response lost");}return {upload_url:"/media/upload"};});
  await expect(addPhotoToAlbum(vault,"photo","album")).resolves.toBeUndefined();
  expect(vi.mocked(post).mock.calls.filter(([path])=>path.endsWith("/grants"))).toHaveLength(1);
 });
});
