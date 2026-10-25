import postgres from 'postgres';
import {z} from 'zod';
import {createMiddleware} from 'hono/factory';
import type {Env, Variables} from './types.js';
import {event} from './telemetry.js';
import {feedTiming,measureFeedPhase} from './feed-timing';

export interface JournalStore {
  get(key: string): Promise<{etag: string; text(): Promise<string>} | null>;
  put(key: string, value: string, options?: {onlyIf?: {etagMatches?: string; etagDoesNotMatch?: string}}): Promise<{etag: string} | null>;
}
const sequence = z.string().regex(/^(0|[1-9][0-9]*)$/);
const pointer = z.object({key: z.string().regex(/^batches\/[a-f0-9-]+\/[0-9]+-[0-9]+-[a-f0-9]{64}\.json$/), hash: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const controlSchema = z.object({
  v: z.literal(1), generation: z.uuid(), mode: z.enum(['active','quarantine']), sequence,
  head: pointer.nullable(), pending: z.array(z.object({id: z.uuid(), started_at: z.string().datetime()})).max(256),
  reason: z.string().max(100).nullable(),
}).strict();
export type JournalControl = z.infer<typeof controlSchema>;
export const eventSchema = z.object({sequence, id: z.uuid(), occurred_at: z.string(), decision: z.record(z.string(), z.unknown())}).strict();
export type JournalEvent = z.infer<typeof eventSchema>;
const batchSchema = z.object({v: z.literal(1), generation: z.uuid(), from: sequence, to: sequence, previous: pointer.nullable(), events: z.array(eventSchema).min(1).max(500)}).strict();
export interface JournalDatabase {
  status(): Promise<{generation: string; sequence: string; quarantined: boolean}>;
  page(after: string): Promise<JournalEvent[]>;
}
const CONTROL = 'control.json';
export class JournalError extends Error {
  constructor(readonly code: string) {super(code);}
}
const stop = (code: string): never => {throw new JournalError(code);};
export async function sha256(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2,'0')).join('');
}
export async function readJournalControl(store: JournalStore) {
  const object = await store.get(CONTROL);
  if (!object) return stop('JOURNAL_NOT_INITIALIZED');
  return {value: controlSchema.parse(JSON.parse(await object.text())), etag: object.etag};
}
async function immutable(store: JournalStore, key: string, value: unknown) {
  const text = JSON.stringify(value);
  if (await store.put(key,text,{onlyIf:{etagDoesNotMatch:'*'}})) return;
  const existing = await store.get(key);
  if (!existing || await existing.text() !== text) stop('JOURNAL_IMMUTABILITY_FAILED');
}
async function replace(store: JournalStore, control: JournalControl, etag: string) {
  return store.put(CONTROL,JSON.stringify(control),{onlyIf:{etagMatches:etag}});
}
export async function assertJournalReadable(store: JournalStore, db: JournalDatabase) {
  const [remote, local] = await Promise.all([readJournalControl(store), db.status()]);
  if (remote.value.mode !== 'active' || local.quarantined) stop('RESTORE_QUARANTINED');
  // Fresh in-flight privacy operations do not stop ordinary member reads.
  // A crashed operation must fail closed even if the scheduled job is delayed.
  if (remote.value.pending.some(p=>Date.now()-Date.parse(p.started_at)>120_000)) {
    await quarantineJournal(store,'unresolved_privacy_operation');
    stop('RESTORE_QUARANTINED');
  }
  if (remote.value.generation !== local.generation || BigInt(local.sequence) < BigInt(remote.value.sequence)) stop('DATABASE_ROLLBACK_DETECTED');
  return remote;
}
/** An owner initializes once, with member traffic disabled until this completes. */
export async function initializePrivacyJournal(store: JournalStore, db: JournalDatabase) {
  const local = await db.status();
  const control: JournalControl = {v:1,generation:local.generation,mode:'quarantine',sequence:'0',head:null,pending:[],reason:'initialization'};
  if (!await store.put(CONTROL,JSON.stringify(control),{onlyIf:{etagDoesNotMatch:'*'}})) stop('JOURNAL_ALREADY_INITIALIZED');
  await checkpointJournal(store,db,true);
}

/** CAS publishes immutable, hash-linked batches. SQL pages are commit ordered. */
export async function checkpointJournal(store: JournalStore, db: JournalDatabase, allowQuarantine = false) {
  const target = await db.status();
  for (let tries=0; tries<256; tries++) {
    const remote = await readJournalControl(store), control = remote.value;
    if (control.mode==='quarantine'&&!allowQuarantine) stop('RESTORE_QUARANTINED');
    const local = await db.status();
    if (control.generation!==local.generation || BigInt(local.sequence)<BigInt(control.sequence)) stop('DATABASE_ROLLBACK_DETECTED');
    if (BigInt(control.sequence)>=BigInt(target.sequence)) return control;
    const events = z.array(eventSchema).parse(await db.page(control.sequence));
    if (!events.length) stop('JOURNAL_GAP');
    let next=BigInt(control.sequence)+1n;
    for (const event of events) {if (BigInt(event.sequence)!==next++) stop('JOURNAL_GAP');}
    const batch = {v:1,generation:control.generation,from:events[0].sequence,to:events.at(-1)!.sequence,previous:control.head,events};
    const content=JSON.stringify(batch), hash=await sha256(content);
    const key=`batches/${control.generation}/${batch.from}-${batch.to}-${hash}.json`;
    await immutable(store,key,batch);
    await replace(store,{...control,sequence:batch.to,head:{key,hash}},remote.etag);
  }
  return stop('JOURNAL_CHECKPOINT_BUSY');
}
export async function beginPrivacyIntent(store: JournalStore, db: JournalDatabase) {
  const intent={id:crypto.randomUUID(),started_at:new Date().toISOString()};
  await immutable(store,`intents/${intent.id}.json`,{v:1,...intent});
  for(let tries=0;tries<40;tries++) {
    const remote=await assertJournalReadable(store,db);
    if(remote.value.pending.length>=256)stop('JOURNAL_BUSY');
    if(await replace(store,{...remote.value,pending:[...remote.value.pending,intent]},remote.etag))return intent;
  }
  return stop('JOURNAL_BUSY');
}
export async function completePrivacyIntent(store: JournalStore, db: JournalDatabase, intent: {id:string;started_at:string}) {
  const checkpoint=await checkpointJournal(store,db);
  await immutable(store,`receipts/${intent.id}.json`,{v:1,id:intent.id,generation:checkpoint.generation,sequence:checkpoint.sequence,head:checkpoint.head});
  for(let tries=0;tries<40;tries++) {
    const remote=await readJournalControl(store);
    if(remote.value.mode!=='active')stop('RESTORE_QUARANTINED');
    if(!remote.value.pending.some(p=>p.id===intent.id))return;
    if(await replace(store,{...remote.value,pending:remote.value.pending.filter(p=>p.id!==intent.id)},remote.etag))return;
  }
  stop('JOURNAL_BUSY');
}
export async function quarantineJournal(store: JournalStore, reason: string) {
  for(let tries=0;tries<40;tries++) {
    const remote=await readJournalControl(store);
    if(remote.value.mode==='quarantine')return remote.value;
    const next={...remote.value,mode:'quarantine' as const,reason};
    if(await replace(store,next,remote.etag))return next;
  }
  return stop('JOURNAL_BUSY');
}
export async function detectStalePrivacyIntents(store: JournalStore, now=Date.now()) {
  const remote=await readJournalControl(store);
  if(remote.value.pending.some(p=>now-Date.parse(p.started_at)>120_000)) {
    await quarantineJournal(store,'unresolved_privacy_operation');
    return true;
  }
  return remote.value.mode==='quarantine';
}

/** Verify the complete immutable chain before a restore applies any records. */
export async function verifyJournalChain(store: JournalStore): Promise<{control:JournalControl;batches:JournalEvent[][]}> {
  const {value:control}=await readJournalControl(store);
  if(control.mode!=='quarantine')stop('RESTORE_QUARANTINE_REQUIRED');
  if(control.pending.length)stop('UNRESOLVED_PRIVACY_INTENTS');
  let current=control.head, expected=BigInt(control.sequence);
  const batches:JournalEvent[][]=[];
  while(current) {
    const object=await store.get(current.key);
    if(!object)stop('JOURNAL_GAP');
    const content=await object!.text();
    if(await sha256(content)!==current.hash)stop('JOURNAL_HASH_MISMATCH');
    const batch=batchSchema.parse(JSON.parse(content));
    if(batch.generation!==control.generation || BigInt(batch.to)!==expected || BigInt(batch.from)+BigInt(batch.events.length)-1n!==expected)stop('JOURNAL_GAP');
    for(let i=0;i<batch.events.length;i++)if(BigInt(batch.events[i].sequence)!==BigInt(batch.from)+BigInt(i))stop('JOURNAL_GAP');
    batches.push(batch.events);expected=BigInt(batch.from)-1n;current=batch.previous;
    if(batches.length>1_000_000)stop('JOURNAL_TOO_LARGE');
  }
  if(expected!==0n)stop('JOURNAL_GAP');
  return {control,batches:batches.reverse()};
}

type RuntimeEnv=Pick<Env,'RECOVERY_JOURNAL'|'HYPERDRIVE_JOBS'|'ENVIRONMENT'>;
function runtime(env:RuntimeEnv) {
  if(!env.RECOVERY_JOURNAL) {
    if(env.ENVIRONMENT==='development')return null;
    return stop('JOURNAL_NOT_CONFIGURED');
  }
  const sql=postgres(env.HYPERDRIVE_JOBS.connectionString,{max:1,prepare:false,fetch_types:false,connect_timeout:10});
  const db:JournalDatabase={
    async status(){const[r]=await sql`select app.safety_status() as value`;return r.value;},
    async page(after){const[r]=await sql`select app.safety_page(${after}::bigint,200) as value`;return r.value;},
  };
  return {store:env.RECOVERY_JOURNAL as JournalStore,db,close:()=>sql.end({timeout:1})};
}
export function isPrivacyMutation(method:string,path:string):boolean {
  const uuid='[a-fA-F0-9-]{36}';
  if(method==='DELETE')return new RegExp(`^/api/v1/(?:account|(?:posts|comments)/${uuid}(?:/reactions/[A-Za-z0-9_-]{16,128})?|(?:devices|connections|blocks|media)/${uuid}|groups/${uuid}(?:/members/${uuid})?)$`).test(path);
  if(['PUT','PATCH'].includes(method))return new RegExp(`^/api/v1/(?:(?:posts|comments|blocks)/${uuid}|profiles/me|groups/${uuid}(?:/members/${uuid})?|keys/backup|connections/${uuid}/kind|media/${uuid}/attachment)$`).test(path);
  if(method!=='POST')return false;
  if(path==='/api/v1/imports')return true; // An import may replace private profile content.
  return new RegExp(`^/api/staff/(?:moderation/reports/${uuid}/actions|recovery/cases/${uuid}/review)$`).test(path);
}
export const privacyReadGuard=createMiddleware<{Bindings:Env;Variables:Variables}>(async(c,next)=>{
  let resources:ReturnType<typeof runtime>=null;
  const timing=feedTiming(c.env,c.req.method,c.req.path);
  try {
    resources=runtime(c.env);
    if(resources)await measureFeedPhase(timing,'journal_check',()=>assertJournalReadable(resources!.store,resources!.db));
  } catch(error) {
    const codes:Record<string,string>={JOURNAL_NOT_INITIALIZED:'journal_not_initialized',RESTORE_QUARANTINED:'restore_quarantined',DATABASE_ROLLBACK_DETECTED:'database_rollback_detected',JOURNAL_NOT_CONFIGURED:'journal_not_configured'};
    event('error',{code:error instanceof JournalError?(codes[error.code]||'journal_unavailable'):'journal_unavailable'},c.env);
    // No identifiers, SQL details, endpoint URLs or private content in errors.
    return c.json({error:{code:'PRIVACY_CHECKPOINT_REQUIRED',message:'This action is temporarily unavailable while data safeguards are checked. Please try again later.'}},503);
  } finally {if(resources)await measureFeedPhase(timing,'journal_close',()=>resources!.close());}
  await next();
});
function knownRollback(error:unknown):boolean {
  const e=error as {code?:string;status?:number;name?:string};
  return !!(e.status&&e.status>=400&&e.status<500)||e.name==='ZodError'
    || !!e.code&&(/^(22|23|40)/.test(e.code)||['P0001','42501'].includes(e.code));
}
/** Mount only after verified member/staff authentication. Unknown routes do not
 * create capabilities or intent records. Public security routes use the explicit
 * wrapper below after token/body/rate validation. */
export const privacyMutationMiddleware=createMiddleware<{Bindings:Env;Variables:Variables}>(async(c,next)=>{
  if(!isPrivacyMutation(c.req.method,c.req.path)||(!c.get('memberId')&&!c.get('staffSubject'))){await next();return;}
  try {
    await withPrivacyJournal(c.env,async()=>{await next();if(c.error&&!knownRollback(c.error))throw c.error;});
  }catch(error){
    if(!(error instanceof JournalError))throw error;
    // The handler may already have finalized a 2xx response. Replace it before
    // Hono sends any bytes; merely returning a response here can retain the 2xx.
    c.res=c.json({error:{code:'PRIVACY_CHECKPOINT_REQUIRED',message:'The change could not be safely confirmed. Please try again later.'}},503);
    return c.res;
  }
});
export async function withPrivacyJournal<T>(env:RuntimeEnv,work:()=>Promise<T>):Promise<T> {
  const resources=runtime(env);
  if(!resources)return work();
  try {
    await detectStalePrivacyIntents(resources.store);
    const intent=await beginPrivacyIntent(resources.store,resources.db);
    let value:T;
    try {value=await work();}
    catch(error){if(knownRollback(error))await completePrivacyIntent(resources.store,resources.db,intent);throw error;}
    try {await completePrivacyIntent(resources.store,resources.db,intent);}
    catch(error){if(error instanceof JournalError)throw error;throw new JournalError('PRIVACY_CHECKPOINT_REQUIRED');}
    return value;
  } finally {await resources.close();}
}
export async function checkpointPrivacyJournal(env:RuntimeEnv) {
  const resources=runtime(env);if(!resources)return;
  try {if(await detectStalePrivacyIntents(resources.store))stop('RESTORE_QUARANTINED');await checkpointJournal(resources.store,resources.db);} finally {await resources.close();}
}
