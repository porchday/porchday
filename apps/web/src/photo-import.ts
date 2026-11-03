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
    await publishPhoto(vault,{
      id,name:old.name || record.name || "photo.jpg",alt:old.alt || "",
      blob:new Blob([bytes as BlobPart],{type:record.mime}),mime:record.mime,
      width:record.width,height:record.height,poster:record.poster,
      photoDate:photo.photo_date,tags:old.tags || [],
    },"only_me",preservedPhotoDeadline(record.expires_at,photo.expires_at),null);
    for (const original of photo.album_ids) {
      ensureContinue();
      const album = mapped.get(original);
      if (album) await addPhotoToAlbum(vault,id,album,true);
    }
  }
}
