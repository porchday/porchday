import {z} from 'zod';
import {verifyStatement} from '@porchday/crypto';
import type {Db} from './db';
export const attachmentDateProof=z.object({statement:z.object({v:z.literal(1),purpose:z.literal('porchday-attachment-date'),mediaId:z.string().uuid(),postId:z.string().uuid(),ownerId:z.string().uuid(),deviceId:z.string().uuid(),date:z.string().date().refine(d=>d>='0001-01-01'&&d<='9999-12-31'),revision:z.number().int().positive()}).strict(),signature:z.string().max(30000)}).strict();
export async function setAttachmentDate(db:Db,member:string,proof:z.infer<typeof attachmentDateProof>,fail:(code:string,status?:400|403)=>never){
 if(proof.statement.ownerId!==member)fail('FORBIDDEN',403);
 const [device]=await db`select public_key from app.device_keys where id=${proof.statement.deviceId} and member_id=${member} and revoked_at is null`;
 if(!device)fail('DEVICE_NOT_TRUSTED',403);
 try{await verifyStatement(proof,device.public_key);}catch{fail('INVALID_SIGNATURE');}
 await db`select app.set_attachment_photo_date(${proof.statement.mediaId},${db.json(proof)})`;
}
