import type {EncryptedEnvelope,Device} from './api';
/** A recovered author already has the original private keys. Do not copy their
 * content solely to add another own-device recipient. This is only a read-side
 * optimization: peer gaps and incomplete recipient-table repairs still run. */
export function onlyRecoveredOwnDevicesMissing(envelope:EncryptedEnvelope,devices:Device[],owner:string,fingerprints:ReadonlySet<string>,peerGrantsComplete=false){
 const missing=devices.filter(d=>!envelope.recipients.some(r=>r.memberId===d.member_id&&r.deviceId===d.id&&r.fingerprint===d.fingerprint));
 return peerGrantsComplete&&missing.length>0&&missing.every(d=>d.member_id===owner)&&hasRecoveredAccess(envelope,owner,fingerprints);
}
export function hasRecoveredAccess(envelope:EncryptedEnvelope,owner:string,fingerprints:ReadonlySet<string>){
 return envelope.recipients.some(r=>r.memberId===owner&&fingerprints.has(r.fingerprint));
}
