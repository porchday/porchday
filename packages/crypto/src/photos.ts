import {canonicalJson,signStatement,verifyStatement,validateContext,type Json,type SignedStatement,type UnlockedPrivateKey} from './index.ts';
export interface PhotoSource {
 v:1;purpose:'porchday-photo-source';photoId:string;ownerId:string;deviceId:string;
 revision:number;date:string;expiresAt:string|null;sha256:string;metadata:{[key:string]:Json};
}
export type PhotoProof=SignedStatement<PhotoSource>;
export function photoMetadata(media:Record<string,unknown>):{[key:string]:Json} {
 const {id:_,...metadata}=media;
 // Normalize optional UI fields exactly as JSON serialization of an envelope.
 return JSON.parse(JSON.stringify(metadata));
}
function validate(source:PhotoSource){
 if(source.v!==1||source.purpose!=='porchday-photo-source'||!/^[0-9a-f]{64}$/.test(source.sha256))throw Error('Invalid photo source proof');
 validateContext({id:source.photoId,kind:'photo',authorId:source.ownerId,authorDeviceId:source.deviceId,audience:'only_me',parentId:null,groupId:null,epoch:0,createdAt:'1970-01-01T00:00:00.000Z',expiresAt:source.expiresAt,revision:source.revision,photoDate:source.date});
 if(!source.metadata||typeof source.metadata!=='object'||Array.isArray(source.metadata)||Object.hasOwn(source.metadata,'id')||canonicalJson(source.metadata).length>200000)throw Error('Invalid photo source metadata');
}
export async function photoBytesHash(bytes:Uint8Array){
 const hash=await crypto.subtle.digest('SHA-256',new Uint8Array(bytes));
 return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function createPhotoProof(source:Omit<PhotoSource,'v'|'purpose'>,key:UnlockedPrivateKey):Promise<PhotoProof>{
 const statement:PhotoSource={v:1,purpose:'porchday-photo-source',...source};validate(statement);return signStatement(statement,key);
}
export async function verifyPhotoProof(proof:PhotoProof,expected:Omit<PhotoSource,'v'|'purpose'|'sha256'>,publicKey:string){
 if(!proof?.statement||typeof proof.signature!=='string')throw Error('Photo owner signature is missing');
 validate(proof.statement);
 const {v:_,purpose:__,sha256:___,...binding}=proof.statement;
 if(canonicalJson(binding)!==canonicalJson(expected))throw Error('Photo owner signature does not match its metadata');
 return verifyStatement(proof,publicKey);
}
export async function verifyPhotoBytes(proof:PhotoProof,bytes:Uint8Array){
 if(await photoBytesHash(bytes)!==proof.statement.sha256)throw Error('Photo bytes do not match the owner signature');
}
