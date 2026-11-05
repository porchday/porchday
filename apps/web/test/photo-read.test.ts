import {generateDeviceKeys,unlockPrivateKey} from "@porchday/crypto";
import {createPhotoProof,photoMetadata} from "@porchday/crypto/photos";
import {beforeAll,describe,it,expect,vi} from "vitest";
import {openPhoto,type PhotoRow,type PhotoGrant} from "../src/PhotoCollection";
let proof:any;
const ownerKey:any={};
const grant:PhotoGrant={author_key:ownerKey,id:"grant",photo_id:"photo",album_id:null,audience:"only_me",media_id:"media",envelope:{context:{kind:"photo",audience:"only_me",groupId:null,id:"grant",parentId:"photo",photoDate:"2026-10-31",revision:2}} as any};
const photo:PhotoRow={owner_key:ownerKey,id:"photo",owner_id:"owner",photo_date:"2026-10-31",revision:2,created_at:"2026-11-02T00:00:00Z",expires_at:null,grants:[grant]};
beforeAll(async()=>{const keys=await generateDeviceKeys("owner","device"),key=await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret);Object.assign(ownerKey,{id:"device",member_id:"owner",public_key:keys.publicKey,fingerprint:keys.fingerprint});proof=await createPhotoProof({photoId:"photo",ownerId:"owner",deviceId:"device",revision:2,date:"2026-10-31",expiresAt:null,sha256:"a".repeat(64),metadata:photoMetadata({id:"media"})},key);});
describe("photo read identity binding",()=>{
 it("passes the logical owner and grant identity to signature verification",async()=>{
  const vault={verifyDevice:vi.fn().mockResolvedValue(undefined),open:vi.fn().mockResolvedValue({media:[{id:"media"}],photoProof:proof})} as any;
  await openPhoto(vault,photo,grant);expect(vault.open).toHaveBeenCalledWith({id:"grant",author_id:"owner",author_key:ownerKey,envelope:grant.envelope});
 });
 it("rejects a substituted date, revision, photo parent or attachment",async()=>{
  const vault={open:vi.fn().mockResolvedValue({media:[{id:"different-media"}]})} as any;
  for(const changed of [{...photo,photo_date:"2000-01-01"},{...photo,revision:3},{...photo,id:"other-photo"}])await expect(openPhoto(vault,changed,grant)).rejects.toThrow(/signed metadata/);
  expect(vault.open).not.toHaveBeenCalled();
  await expect(openPhoto(vault,photo,grant)).rejects.toThrow(/attachment/);
 });
});
