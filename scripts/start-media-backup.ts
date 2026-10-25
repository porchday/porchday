import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {R2JournalStore} from './r2-journal-store.js';
import {readJournalControl,controlSchema} from '../apps/api/src/privacy-journal.js';
import {readRestorePrivate,writeRestorePrivate} from './restore-private-files.js';

// Privileged operator only. The deployed jobs identity cannot create a manual
// inventory; once created, it uses the same queue/copier as a daily snapshot.
const ticketSchema=z.object({v:z.literal(1),environment:z.enum(['staging','production']),branchId:z.string().min(1),id:z.uuid(),pairedAt:z.iso.datetime(),generation:z.uuid(),sourceControl:controlSchema,captureVerified:z.boolean()}).strict();
const environment=process.argv[2],resume=process.argv.find(value=>value.startsWith('--resume='))?.slice(9);
let sql:ReturnType<typeof postgres>|undefined;
try {
 if(!['staging','production'].includes(environment)||!process.argv.includes('--run')||process.argv.slice(3).some(arg=>arg!=='--run'&&!arg.startsWith('--resume=')))throw Error('MANUAL_BACKUP_ARGUMENTS_INVALID');
 if(resume&&!z.uuid().safeParse(resume).success)throw Error('MANUAL_BACKUP_ID_INVALID');
 const resources=JSON.parse(await readFile(new URL('../infra/resources.json',import.meta.url),'utf8'));
 const configured=resources.environments[environment],prefix='PORCHDAY_'+environment.toUpperCase();
 const urlValue=process.env[prefix+'_DATABASE_MIGRATION_URL'],account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN??process.env.CF_API_TOKEN;
 if(!urlValue||account!==resources.account_id||!token||!configured.media_backup_enabled||configured.verified_pitr_days<7)throw Error('MANUAL_BACKUP_CONFIGURATION_INVALID');
 const url=new URL(urlValue);
 // PlanetScale's full username is branch-qualified. Do not permit a generic
 // database URL or local connection to be accidentally paired with live R2.
 if(!url.hostname.endsWith('.pg.psdb.cloud')||!decodeURIComponent(url.username).endsWith('.'+configured.database.branch_id)||url.port!=='5432')throw Error('MANUAL_BACKUP_DATABASE_MISMATCH');
 sql=postgres(urlValue,{max:1,prepare:false,fetch_types:false,connect_timeout:10,ssl:'verify-full',onnotice:()=>{}});
 const source=R2JournalStore.fromEnvironment(configured.recovery_journal_bucket),control=await readJournalControl(source);
 const [status]=await sql`select app.safety_status() value`;
 if(control.value.mode!=='active'||control.value.pending.length||status.value.quarantined||status.value.generation!==control.value.generation||status.value.sequence!==control.value.sequence)throw Error('MANUAL_BACKUP_CHECKPOINT_NOT_STABLE');
 const directory=resolve('artifacts/private/restore-ops/manual-media-backups');
 const id=resume??crypto.randomUUID(),path=resolve(directory,environment+'-'+id+'.json');
 let ticket:z.infer<typeof ticketSchema>;
 if(resume)ticket=ticketSchema.parse(await readRestorePrivate(path));
 else {
  const [clock]=await sql`select clock_timestamp() paired_at`;
  ticket={v:1,environment:environment as 'staging'|'production',branchId:configured.database.branch_id,id,pairedAt:new Date(clock.paired_at).toISOString(),generation:status.value.generation,sourceControl:control.value,captureVerified:false};
  // Record before SQL/queue calls. Ambiguous network outcomes can always retry
  // exactly this UUID/time; neither a daily inventory nor another run changes.
  await writeRestorePrivate(path,ticket,true);
 }
 if(ticket.environment!==environment||ticket.branchId!==configured.database.branch_id||ticket.generation!==status.value.generation||ticket.id!==id)throw Error('MANUAL_BACKUP_TICKET_MISMATCH');
 if(!ticket.captureVerified&&JSON.stringify(control.value)!==JSON.stringify(ticket.sourceControl))throw Error('MANUAL_BACKUP_CAPTURE_CHANGED');
 const [created]=await sql`select app.media_backup_start_manual(${id}::uuid,${ticket.pairedAt}::timestamptz) value`;
 if(created.value.id!==id||created.value.day!==null||new Date(created.value.restore_at).toISOString()!==ticket.pairedAt)throw Error('MANUAL_BACKUP_RESPONSE_INVALID');
 if(!ticket.captureVerified){
  const after=await readJournalControl(source),[local]=await sql`select app.safety_status() value`;
  if(JSON.stringify(after.value)!==JSON.stringify(ticket.sourceControl)||after.value.pending.length||local.value.quarantined||local.value.generation!==ticket.generation||local.value.sequence!==ticket.sourceControl.sequence)throw Error('MANUAL_BACKUP_CAPTURE_CHANGED');
  ticket.captureVerified=true;await writeRestorePrivate(path,ticket);
 }
 const response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/queues/'+configured.queue_id+'/messages',{
  method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body:JSON.stringify({body:{kind:'media_backup',id},content_type:'json'}),redirect:'error',signal:AbortSignal.timeout(30000),
 });
 const result=await response.json() as {success?:boolean};if(!response.ok||result.success!==true)throw Error('MANUAL_BACKUP_QUEUE_FAILED');
 console.log(JSON.stringify({queued:true,environment,id,paired_at:ticket.pairedAt,expires_at:new Date(created.value.expires_at).toISOString()}));
} catch(error) {
 const code=(error as Error).message;console.error(/^[A-Z][A-Z0-9_]{2,100}$/.test(code)?code:'MANUAL_BACKUP_OPERATION_FAILED');process.exitCode=1;
} finally {await sql?.end({timeout:1});}
