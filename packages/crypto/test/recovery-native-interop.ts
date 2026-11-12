// Synthetic runtime fixture: no member keys are stored in the repository.
import {writeFile} from 'node:fs/promises';
import {generateDeviceKeys,unlockPrivateKey} from '../src/index.ts';
import {sealRecoveryPayload} from '../src/recovery.ts';
const author=await generateDeviceKeys('synthetic-member','device'),recipient=await generateDeviceKeys('synthetic-member','recovery');
const key=await unlockPrivateKey(author.encryptedPrivateKey,author.recoverySecret);
const binding={v:1 as const,purpose:'porchday-device-backup' as const,memberId:'synthetic-member',methodId:'device',requestId:'',recipientFingerprint:recipient.fingerprint};
await writeFile(process.argv[2],JSON.stringify({author,recipient,binding,ciphertext:await sealRecoveryPayload(binding,key.armor(),recipient.publicKey,key)}),{mode:0o600});
