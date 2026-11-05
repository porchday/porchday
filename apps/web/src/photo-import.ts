import {signAttachmentDate} from "./attachment-photo-date";
import { ApiError, get, post, type Json } from "./api";
import { checksum, preservedPhotoDeadline } from "./archive";
import { publishPhoto } from "./photo-publish";
import { addPhotoToAlbum } from "./photo-album";
import type { useVault } from "./vault";

/** Account-scoped, stable identities make interrupted imports resumable. */
export async function importedIdentity(owner: string, source: string, kind: string, id: string) {
  const hash = await checksum(new TextEncoder().encode(JSON.stringify(["porchday-import-v1", owner, source, kind, id])));
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export async function importPhotoCollections(
  vault: ReturnType<typeof useVault>, source: string, albums: Json[], photos: Json[],
  load: (id: string) => Promise<{bytes: Uint8Array; record: Json}>,
  ensureContinue: () => void,
  progress: (text: string) => void,
) {
  const mapped = new Map<string,string>();
  for (const album of albums) {
    ensureContinue();
    const id = await importedIdentity(vault.member.id,source,"album",album.id);
    const provenance = {source_member_id:source,source_id:album.id};
    async function exists() {
      try {
        const {album: row, members} = await get("/albums/"+id);
        const content = await vault.open(row) as Json;
        if (row.owner_id !== vault.member.id || content.provenance?.source_member_id !== source || content.provenance?.source_id !== album.id)
          throw Error("An imported album identity conflicts with an existing album.");
        if (members.some((member: Json) => member.member_id !== vault.member.id)) throw Error("This imported album is now shared. Import stopped before adding private photos.");
        return true;
      } catch (error) { if (error instanceof ApiError && error.status === 404) return false; throw error; }
    }
    if (!await exists()) {
      progress("Restoring your owned albums privately…");
      const envelope = await vault.seal({name:album.payload.name,description:album.payload.description || "",provenance},{id,kind:"album",audience:"only_me"});
      try { await post("/albums",{envelope}); } catch (error) { if (!await exists()) throw error; }
    }
    mapped.set(album.id,id);
  }
  for (let index=0;index<photos.length;index++) {
    ensureContinue();
    const photo = photos[index], old = photo.payload.media[0];
    if (photo.expires_at && Date.parse(photo.expires_at)<=Date.now()) continue;
    const {bytes,record} = await load(old.id);
    if (record.expires_at && Date.parse(record.expires_at)<=Date.now()) continue;
    progress(`Restoring photos (${index+1}/${photos.length})…`);
    const id = await importedIdentity(vault.member.id,source,"photo",photo.id);
    let existingSource;
    if(photo.source_post_id&&photo.source_media_id){
      try{
        const current=(await get("/photos/"+id)).photo;
        if(current.source_media_id){
          const postId=await importedIdentity(vault.member.id,source,"post",photo.source_post_id);
          const {post:row}=await get("/posts/"+postId);
          const content=await vault.open(row) as Json;
          const mapping=content.provenance?.source_media?.find((m:Json)=>m.source_id===photo.source_media_id);
          if(current.owner_id!==vault.member.id||current.source_post_id!==postId||mapping?.media_id!==current.source_media_id||content.provenance?.source_member_id!==source||content.provenance?.source_id!==photo.source_post_id)
            throw Error("Imported photo has different source provenance.");
          existingSource={mediaId:current.source_media_id,postId};
        }
      }catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;}
    }
    await publishPhoto(vault,{
      id,name:old.name || record.name || "photo.jpg",alt:old.alt || "",
      blob:new Blob([bytes as BlobPart],{type:record.mime}),mime:record.mime,
      width:record.width,height:record.height,poster:record.poster,
      photoDate:photo.photo_date,tags:old.tags || [],existingSource,
    },"only_me",preservedPhotoDeadline(record.expires_at,photo.expires_at),null);
    for (const original of photo.album_ids) {
      ensureContinue();
      const album = mapped.get(original);
      if (album) await addPhotoToAlbum(vault,id,album,true);
    }
  }
}

/** Rejoin imported post attachments and their independent album paths. */
export async function restorePhotoSources(vault:ReturnType<typeof useVault>,source:string,photos:Json[],ensureContinue:()=>void){
  for(const original of photos){
    ensureContinue();
    if(!original.source_media_id||!original.source_post_id)continue;
    if(original.expires_at&&Date.parse(original.expires_at)<=Date.now())continue;
    const photoId=await importedIdentity(vault.member.id,source,"photo",original.id);
    const postId=await importedIdentity(vault.member.id,source,"post",original.source_post_id);
    let postRow;
    try{postRow=(await get("/posts/"+postId)).post;}
    catch(error){if(error instanceof ApiError&&error.status===404)continue;throw error;}
    if(postRow.author_id!==vault.member.id)throw Error("Imported source post has a different owner.");
    const content=await vault.open(postRow) as Json;
    if(content.provenance?.source_member_id!==source||content.provenance?.source_id!==original.source_post_id)throw Error("Imported source post has different provenance.");
    const mapping=content.provenance.source_media?.find((m:Json)=>m.source_id===original.source_media_id);
    if(!mapping||!postRow.media.some((m:Json)=>m.id===mapping.media_id))continue;
    const {photo}=await get("/photos/"+photoId);
    if(photo.source_media_id){
      if(photo.source_media_id!==mapping.media_id||photo.source_post_id!==postId)throw Error("Imported photo has a different source attachment.");
      continue;
    }
    const {date}=await get(`/media/${mapping.media_id}/photo-date`);
    const source_date=await signAttachmentDate(vault,mapping.media_id,postId,photo.photo_date,(date?.revision||0)+1);
    try{await post(`/photos/${photoId}/source`,{media_id:mapping.media_id,source_date});}
    catch(error){const current=(await get("/photos/"+photoId)).photo;if(current.source_media_id!==mapping.media_id||current.source_post_id!==postId)throw error;}
  }
}
