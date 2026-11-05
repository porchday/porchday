import {beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("../src/api",async original=>({...await original<typeof import("../src/api")>(),get:vi.fn()}));
vi.mock("../src/photo-publish",()=>({publishPhoto:vi.fn()}));
vi.mock("../src/photo-album",()=>({addPhotoToAlbum:vi.fn()}));
vi.mock("../src/attachment-photo-date",()=>({verifyAttachmentDate:vi.fn()}));
vi.mock("../src/video",()=>({validatedMedia:vi.fn(async()=>({width:10,height:20}))}));
import {get,ApiError} from "../src/api";
import {publishPhoto} from "../src/photo-publish";
import {addPhotoToAlbum} from "../src/photo-album";
import {adoptAttachment} from "../src/photo-adopt";
const vault={member:{id:"owner"},open:vi.fn(async(row)=>row.envelope.payload)} as any;
const original={id:"post",author_id:"owner",expires_at:"2090-01-01T00:00:00.000Z",media:[{id:"media"}],envelope:{payload:{media:[{id:"media",mime:"image/jpeg",alt:"Caption",tags:[]}]}}};
beforeEach(()=>{
 vi.clearAllMocks();vi.mocked(get).mockImplementation(async(path)=>{
  if(path==="/photos/media")throw new ApiError(404,{error:{code:"NOT_FOUND"}});
  if(path==="/posts/post")return {post:original};
  if(path==="/media/media/photo-date")return {date:null};
  if(path==="/media/media/bytes")return {context:{kind:"media",parentId:"post",authorId:"owner",expiresAt:null},payload:{bytes:"aGVsbG8=",mime:"image/jpeg"}};
  throw Error("Unexpected request "+path);
 });
});
describe("post attachment adoption",()=>{
 it("uses source identity, signed original content and earliest deadline without changing the post",async()=>{
  await adoptAttachment(vault,"post","media","2001-02-03","album");
  expect(publishPhoto).toHaveBeenCalledWith(vault,expect.objectContaining({id:"media",photoDate:"2001-02-03",source:{postId:"post",revision:1},alt:"Caption",width:10,height:20}),"only_me","2090-01-01T00:00:00.000Z","album");
  expect(addPhotoToAlbum).not.toHaveBeenCalled();
 });
 it("reuses an adopted identity on retry or when adding another album",async()=>{
  vi.mocked(get).mockResolvedValue({photo:{owner_id:"owner",source_media_id:"media",source_post_id:"post"}});
  await adoptAttachment(vault,"post","media","2001-02-03","album");
  expect(addPhotoToAlbum).toHaveBeenCalledWith(vault,"media","album");expect(publishPhoto).not.toHaveBeenCalled();
 });
 it("refuses to republish another member's attached photo",async()=>{
  vi.mocked(get).mockRejectedValueOnce(new ApiError(404,{error:{code:"NOT_FOUND"}})).mockResolvedValueOnce({post:{...original,author_id:"someone-else"}});
  await expect(adoptAttachment(vault,"post","media","2001-02-03","album")).rejects.toThrow(/Only the owner/);
  expect(publishPhoto).not.toHaveBeenCalled();
 });
 it("does not use a media envelope belonging to another post",async()=>{
  const originalGet=vi.mocked(get).getMockImplementation()!;
  vi.mocked(get).mockImplementation(async(path)=>path==="/media/media/bytes"?{context:{kind:"media",parentId:"another-post",authorId:"owner"}}:originalGet(path));
  await expect(adoptAttachment(vault,"post","media","2001-02-03","album")).rejects.toThrow(/original post/);
  expect(publishPhoto).not.toHaveBeenCalled();
 });
});
