import {beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("../src/api",async original=>({...await original<typeof import("../src/api")>(),get:vi.fn(),post:vi.fn()}));
vi.mock("../src/photo-publish",()=>({publishPhoto:vi.fn()}));
vi.mock("../src/photo-album",()=>({addPhotoToAlbum:vi.fn()}));
import {get,post,ApiError} from "../src/api";
import {publishPhoto} from "../src/photo-publish";
import {addPhotoToAlbum} from "../src/photo-album";
import {importPhotoCollections,importedIdentity,restorePhotoSources} from "../src/photo-import";
vi.mock("../src/attachment-photo-date",()=>({signAttachmentDate:vi.fn(async(_vault,mediaId,postId,date,revision)=>({statement:{mediaId,postId,date,revision},signature:"synthetic"}))}));
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
 it("rejoins restored source attachments after a lost link response without rewriting the post",async()=>{
  const imported=await importedIdentity("owner","source","photo",photo.id),postId=await importedIdentity("owner","source","post","source-post");
  let linked=false;
  vi.mocked(get).mockImplementation(async path=>{
    if(path==="/posts/"+postId)return {post:{author_id:"owner",media:[{id:"new-media"}],payload:{provenance:{source_member_id:"source",source_id:"source-post",source_media:[{source_id:"old-source",media_id:"new-media"}]}}}};
    if(path==="/photos/"+imported)return {photo:{photo_date:photo.photo_date,...(linked?{source_media_id:"new-media",source_post_id:postId}:{})}};
    if(path==="/media/new-media/photo-date")return {date:{revision:1}};
    throw Error("Unexpected read "+path);
  });
  vi.mocked(post).mockImplementation(async()=>{linked=true;throw Error("Lost response");});
  const restored={...photo,source_media_id:"old-source",source_post_id:"source-post"};
  await restorePhotoSources(vault,"source",[restored],()=>{});
  expect(post).toHaveBeenCalledWith("/photos/"+imported+"/source",{media_id:"new-media",source_date:{statement:{mediaId:"new-media",postId,date:photo.photo_date,revision:2},signature:"synthetic"}});
  await restorePhotoSources(vault,"source",[restored],()=>{});
  expect(post).toHaveBeenCalledTimes(1);
 });
 it("retains independent photos when their original post was not in the archive",async()=>{
  await restorePhotoSources(vault,"source",[{...photo,source_media_id:"old-source",source_post_id:"removed-post"}],()=>{});
  expect(post).not.toHaveBeenCalled();
 });
 it("accepts an already restored source association only when its imported provenance matches",async()=>{
  const postId=await importedIdentity("owner","source","post","old-post");
  vi.mocked(get).mockImplementation(async path=>path.startsWith("/photos/")?{photo:{owner_id:"owner",source_media_id:"new-media",source_post_id:postId}}:{post:{payload:{provenance:{source_member_id:"source",source_id:"old-post",source_media:[{source_id:"old-source",media_id:"new-media"}]}}}});
  await importPhotoCollections(vault,"source",[],[{...photo,album_ids:[],source_media_id:"old-source",source_post_id:"old-post"}],load,()=>{},()=>{});
  expect(publishPhoto).toHaveBeenCalledWith(vault,expect.objectContaining({existingSource:{mediaId:"new-media",postId}}),"only_me","2090-01-01T00:00:00.000Z",null);
 });

});
