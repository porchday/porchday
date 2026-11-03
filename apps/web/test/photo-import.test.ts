import {beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("../src/api",async original=>({...await original<typeof import("../src/api")>(),get:vi.fn(),post:vi.fn()}));
vi.mock("../src/photo-publish",()=>({publishPhoto:vi.fn()}));
vi.mock("../src/photo-album",()=>({addPhotoToAlbum:vi.fn()}));
import {get,post,ApiError} from "../src/api";
import {publishPhoto} from "../src/photo-publish";
import {addPhotoToAlbum} from "../src/photo-album";
import {importPhotoCollections,importedIdentity} from "../src/photo-import";
const vault={member:{id:"owner"},seal:vi.fn(async(payload,context)=>({payload,context})),open:vi.fn(async row=>row.payload)} as any;
const album={id:"old-album",payload:{name:"Family",description:"Memories"}};
const photo={id:"old-photo",photo_date:"2001-02-03",expires_at:null,album_ids:["old-album","someone-elses-album"],payload:{media:[{id:"old-media",name:"day.jpg",alt:"caption"}]}};
const load=vi.fn(async()=>({bytes:new Uint8Array([1,2,3]),record:{mime:"image/jpeg",width:2,height:3,expires_at:"2090-01-01T00:00:00.000Z"}}));
beforeEach(()=>{vi.clearAllMocks();vi.mocked(get).mockRejectedValue(new ApiError(404,{error:{code:"NOT_FOUND"}}));vi.mocked(post).mockResolvedValue({});});
describe("private photo collection import",()=>{
 it("restores independent photos, original dates and only owned album paths privately",async()=>{
  await importPhotoCollections(vault,"source",[album],[photo],load,()=>{},()=>{});
  expect(vi.mocked(post).mock.calls.map(([path])=>path)).toEqual(["/albums"]);
  const body=vi.mocked(post).mock.calls[0][1] as any;
  expect(body.envelope.context.audience).toBe("only_me");
  expect(body.envelope.payload.provenance).toEqual({source_member_id:"source",source_id:album.id});
  expect(publishPhoto).toHaveBeenCalledWith(vault,expect.objectContaining({photoDate:"2001-02-03",alt:"caption"}),"only_me","2090-01-01T00:00:00.000Z",null);
  expect(addPhotoToAlbum).toHaveBeenCalledTimes(1);
  expect(addPhotoToAlbum).toHaveBeenCalledWith(vault,await importedIdentity("owner","source","photo",photo.id),await importedIdentity("owner","source","album",album.id),true);
 });
 it("reconciles an album creation response loss using the same account-scoped identity",async()=>{
  vi.mocked(get).mockRejectedValueOnce(new ApiError(404,{error:{code:"NOT_FOUND"}})).mockResolvedValue({album:{owner_id:"owner",payload:{provenance:{source_member_id:"source",source_id:album.id}}},members:[{member_id:"owner"}]});
  vi.mocked(post).mockRejectedValue(Error("response lost"));
  await importPhotoCollections(vault,"source",[album],[],load,()=>{},()=>{});
  expect(post).toHaveBeenCalledTimes(1);
  expect(await importedIdentity("owner","source","photo","x")).not.toBe(await importedIdentity("other","source","photo","x"));
 });
 it("stops before restoring photos into an album that has since been shared",async()=>{
  vi.mocked(get).mockResolvedValue({album:{owner_id:"owner",payload:{provenance:{source_member_id:"source",source_id:album.id}}},members:[{member_id:"other"}]});
  await expect(importPhotoCollections(vault,"source",[album],[photo],load,()=>{},()=>{})).rejects.toThrow(/now shared/);
  expect(publishPhoto).not.toHaveBeenCalled();expect(addPhotoToAlbum).not.toHaveBeenCalled();
 });
 it("does not revive expired photos",async()=>{
  await importPhotoCollections(vault,"source",[],[{...photo,expires_at:"2000-01-01T00:00:00Z"}],load,()=>{},()=>{});
  expect(load).not.toHaveBeenCalled();expect(publishPhoto).not.toHaveBeenCalled();
 });
});
