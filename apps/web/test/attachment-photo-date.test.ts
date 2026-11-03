import {beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {generateDeviceKeys,unlockPrivateKey} from '@porchday/crypto';
vi.mock('../src/api',async original=>({...await original<typeof import('../src/api')>(),get:vi.fn(),request:vi.fn()}));
import {get,request} from '../src/api';
import {signAttachmentDate,verifyAttachmentDate,updateAttachmentDate} from '../src/attachment-photo-date';
let vault:any,key:any;
beforeAll(async()=>{const keys=await generateDeviceKeys('owner','device');key={id:'device',member_id:'owner',public_key:keys.publicKey,fingerprint:keys.fingerprint};vault={member:{id:'owner'},device:key,privateKey:await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret),verifyDevice:vi.fn()};});
beforeEach(()=>{vi.clearAllMocks();});
it('verifies an owner-signed calendar date and rejects changing its date or attachment identity',async()=>{
 const proof=await signAttachmentDate(vault,'media','post','2000-02-29',1),record={media_id:'media',photo_date:'2000-02-29',revision:1,proof,author_key:key};
 await expect(verifyAttachmentDate(vault,record,'media','post','owner','2000-02-29')).resolves.toBeUndefined();
 await expect(verifyAttachmentDate(vault,record,'other','post','owner','2000-02-29')).rejects.toThrow();
 await expect(verifyAttachmentDate(vault,{...record,photo_date:'2001-02-28'},'media','post','owner','2001-02-28')).rejects.toThrow();
 await expect(verifyAttachmentDate(vault,{...record,proof:{...proof,signature:proof.signature.replace('BEGIN','WRONG')}},'media','post','owner','2000-02-29')).rejects.toThrow();
 expect(()=>signAttachmentDate(vault,'media','post','2001-02-29',1)).toThrow();
});
it('reconciles a lost date-update response and does not mistake a competing edit for success',async()=>{
 vi.mocked(get).mockResolvedValueOnce({date:{revision:4}});
 vi.mocked(request).mockImplementation(async(_path,options)=>{const proof=JSON.parse(options!.body as string);vi.mocked(get).mockResolvedValueOnce({date:{proof}});throw Error('Response lost');});
 await expect(updateAttachmentDate(vault,'media','post','1970-01-01')).resolves.toBeUndefined();
 expect(JSON.parse(vi.mocked(request).mock.calls[0][1]!.body as string).statement.revision).toBe(5);
 vi.mocked(get).mockResolvedValueOnce({date:{revision:5}});
 vi.mocked(request).mockImplementation(async()=>{vi.mocked(get).mockResolvedValueOnce({date:{proof:{}}});throw Error('Conflicting write');});
 await expect(updateAttachmentDate(vault,'media','post','1970-01-01')).rejects.toThrow('Conflicting write');
});
