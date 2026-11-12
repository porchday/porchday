import {readRecoveryBackup,type RecoveryBackup} from '@porchday/crypto/recovery';
export type {RecoveryBackup};
/** A read-only restore rehearsal. Never return, persist or enroll recovered keys. */
export async function verifyRecoveryBackup(backup:RecoveryBackup,secret:string,memberId=''):Promise<void>{
 if(backup?.v!==1||!backup.devices?.length||!backup.recovery?.fingerprint)throw Error('No complete recovery backup is available. Keep this device signed in.');
 try{await readRecoveryBackup(backup,secret,memberId);}catch{throw Error('That secret could not unlock the complete backup. Check the saved copy for this account. Keep this device signed in.');}
}
