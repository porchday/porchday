import {sha256} from '../apps/api/src/privacy-journal.js';
import {originalPrimaryRecoveryTicketSchema} from '../apps/api/src/restore-journal.js';

export function originalPrimaryRecoveryArguments(args:string[]){
  const tickets=args.filter(a=>a.startsWith('--ticket=')),evidence=args.filter(a=>a.startsWith('--evidence=')),environments=args.filter(a=>a.startsWith('--environment='));
  if(args.length!==4||!args.includes('--run')||tickets.length!==1||evidence.length!==1||environments.length!==1)throw Error('ORIGINAL_PRIMARY_EXPLICIT_ARGUMENTS_REQUIRED');
  const environment=environments[0].slice(14),ticketPath=tickets[0].slice(9),evidencePath=evidence[0].slice(11);
  if((environment!=='staging'&&environment!=='production')||!ticketPath||!evidencePath)throw Error('ORIGINAL_PRIMARY_EXPLICIT_ARGUMENTS_REQUIRED');
  return {environment,ticketPath,evidencePath};
}

/** Pure validation kept separate so refused operator configurations are tested
 * without loading credentials or starting a temporary Cloudflare endpoint. */
export async function validateOriginalPrimaryConfiguration(input:{ticket:unknown;environment:string;evidence:unknown;resources:any;account?:string;bucket:string;mediaBucket?:string;databaseUrl?:string;head:string;trackedChanges:string;pgLocal?:string}){
  const ticket=originalPrimaryRecoveryTicketSchema.parse(input.ticket),source=ticket.source;
  if(input.environment!==ticket.environment)throw Error('ORIGINAL_PRIMARY_ENVIRONMENT_MISMATCH');
  const configured=input.resources?.environments?.[ticket.environment];
  if(input.pgLocal==='true')throw Error('ORIGINAL_PRIMARY_VERIFIED_TLS_REQUIRED');
  if(input.trackedChanges.trim()||input.head!==source.reviewedCommit)throw Error('ORIGINAL_PRIMARY_REVIEWED_CHECKOUT_REQUIRED');
  if(await sha256(JSON.stringify(input.evidence))!==ticket.evidenceSha256)throw Error('ORIGINAL_PRIMARY_EVIDENCE_MISMATCH');
  if(!configured||input.account!==input.resources.account_id||input.bucket!==configured.recovery_journal_bucket||input.mediaBucket!==configured.bucket
    ||ticket.journalBucket!==input.bucket||ticket.mediaBucket!==input.mediaBucket||source.organization!==configured.database.organization
    ||source.name!==configured.database.name||source.branch!==configured.database.branch||source.branchId!==configured.database.branch_id)throw Error('ORIGINAL_PRIMARY_SOURCE_MISMATCH');
  let url:URL;try{url=new URL(input.databaseUrl??'invalid:');}catch{throw Error('ORIGINAL_PRIMARY_DATABASE_MISMATCH');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname.endsWith('.pg.psdb.cloud')||url.port!=='5432'
    ||!decodeURIComponent(url.username).endsWith('.'+source.branchId))throw Error('ORIGINAL_PRIMARY_DATABASE_MISMATCH');
  return ticket;
}
