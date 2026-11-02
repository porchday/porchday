import {canonicalJson,signStatement,verifyStatement,validateContext,type SignedStatement} from '@porchday/crypto';
import {get,request,type Device} from './api';
import type {useVault} from './vault';
export type AttachmentDateStatement={v:1;purpose:'porchday-attachment-date';mediaId:string;postId:string;ownerId:string;deviceId:string;date:string;revision:number};
export type AttachmentDate={media_id:string;photo_date:string|null;revision:number;proof:SignedStatement<AttachmentDateStatement>;author_key:Device};
function validateDate(date:string,revision:number){validateContext({id:'date',kind:'photo',authorId:'owner',authorDeviceId:'device',parentId:null,groupId:null,audience:'only_me',epoch:0,revision,createdAt:'1970-01-01T00:00:00.000Z',expiresAt:null,photoDate:date});}
export function signAttachmentDate(vault:ReturnType<typeof useVault>,mediaId:string,postId:string,date:string,revision:number){
 validateDate(date,revision);
 return signStatement<AttachmentDateStatement>({v:1,purpose:'porchday-attachment-date',mediaId,postId,ownerId:vault.member.id,deviceId:vault.device.id,date,revision},vault.privateKey);
}
export async function verifyAttachmentDate(vault:ReturnType<typeof useVault>,record:AttachmentDate,mediaId:string,postId:string,ownerId:string,day:string){
 if(!record.photo_date||record.photo_date!==day||record.media_id!==mediaId||record.author_key.member_id!==ownerId)throw Error('The photo date needs to be restored by its owner.');
 validateDate(day,record.revision);await vault.verifyDevice(record.author_key);
 const expected={v:1,purpose:'porchday-attachment-date',mediaId,postId,ownerId,deviceId:record.author_key.id,date:day,revision:record.revision};
 if(canonicalJson(record.proof.statement)!==canonicalJson(expected))throw Error('Photo date does not match its owner signature.');
 await verifyStatement(record.proof,record.author_key.public_key);
}
export async function updateAttachmentDate(vault:ReturnType<typeof useVault>,mediaId:string,postId:string,date:string){
 const {date:current}=await get(`/media/${mediaId}/photo-date`);
 const proof=await signAttachmentDate(vault,mediaId,postId,date,(current?.revision||0)+1);
 try{await request(`/media/${mediaId}/photo-date`,{method:'PUT',body:JSON.stringify(proof)});}
 catch(error){const {date:latest}=await get(`/media/${mediaId}/photo-date`);if(canonicalJson(latest?.proof??null)!==canonicalJson(proof))throw error;}
}
