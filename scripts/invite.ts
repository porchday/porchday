import postgres from 'postgres';
import {createHash,randomBytes} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
// Operator CLI is the only invitation issuer until real-member admission is approved.
const email=process.argv[2];
if(!email?.includes('@')||!process.env.DATABASE_MIGRATION_URL)throw new Error('Usage: invite.ts EMAIL with DATABASE_MIGRATION_URL set');
const token=randomBytes(32).toString('base64url');
const db=postgres(process.env.DATABASE_MIGRATION_URL,{max:1,prepare:false,ssl:process.env.PG_LOCAL==='true'?false:'verify-full'});
try{
 await db`INSERT INTO public.pilot_invitations(token_hash,email,expires_at) VALUES(${createHash('sha256').update(token).digest('hex')},${email.toLowerCase().trim()},now()+interval '7 days')`;
 const dir=homedir()+'/.config/inner-circle/invitations';await mkdir(dir,{recursive:true,mode:0o700});
 const path=dir+'/'+Date.now()+'.txt';
 await writeFile(path,`${process.env.APP_URL||'https://porchday.com'}/join#invite=${token}\n`,{mode:0o600});
 console.log('Invitation saved privately to '+path+' (expires in 7 days).');
}finally{await db.end();}
