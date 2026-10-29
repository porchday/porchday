import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {Env} from '../src/types';

const steps=vi.hoisted(()=>({journal:vi.fn(),expiry:vi.fn(),identity:vi.fn(),metadata:vi.fn(),webPush:vi.fn(),nativePush:vi.fn(),email:vi.fn(),heartbeat:vi.fn(),denial:vi.fn(),partition:vi.fn()}));
vi.mock('../src/db',async original=>({...await original<typeof import('../src/db')>(),cleanupExpired:steps.expiry}));
vi.mock('../src/privacy-journal',async original=>({...await original<typeof import('../src/privacy-journal')>(),withPrivacyJournal:steps.journal}));
vi.mock('../src/identity-cleanup',()=>({cleanupDeletedIdentities:steps.identity}));
vi.mock('../src/metadata-cleanup',()=>({cleanupAuthenticationMetadata:steps.metadata}));
vi.mock('../src/social-push',async original=>({...await original<typeof import('../src/social-push')>(),processWebPush:steps.webPush}));
vi.mock('../src/social-native-push',async original=>({...await original<typeof import('../src/social-native-push')>(),processNativePush:steps.nativePush}));
vi.mock('../src/email-outbox',async original=>({...await original<typeof import('../src/email-outbox')>(),processAccountEmails:steps.email}));
vi.mock('../src/operations-health',async original=>({...await original<typeof import('../src/operations-health')>(),recordCleanupSuccess:steps.heartbeat}));
vi.mock('../src/session-denial-candidates',async original=>({...await original<typeof import('../src/session-denial-candidates')>(),cleanupDeniedSessionCandidates:steps.denial}));
vi.mock('../src/session-denial-runtime',async original=>({...await original<typeof import('../src/session-denial-runtime')>(),cleanupDenialPartition:steps.partition}));
import worker from '../src/index';

describe('Cleanup failure phase diagnostics preserve queue behavior',()=>{
 let points:AnalyticsEngineDataPoint[],env:Env,message:{body:{kind:string;denialProgressEtag?:string;denialPartition?:number};ack:ReturnType<typeof vi.fn>;retry:ReturnType<typeof vi.fn>};
 const secretError=()=>Object.assign(Error('private SQL password=email-link member@example.test'),{code:'private-error-code'});
 beforeEach(()=>{
  for(const step of Object.values(steps))step.mockReset();
  steps.denial.mockResolvedValue({seen:2,deleted:1,invalid:1,advanced:false});steps.partition.mockResolvedValue({seen:2,deleted:1,invalid:0,advanced:false});
  steps.journal.mockImplementation(async(_env,work)=>work());steps.expiry.mockResolvedValue({posts:0,comments:0,abandoned_media:0,deleted_objects:2});
  for(const name of ['identity','metadata','webPush','nativePush','email','heartbeat'] as const)steps[name].mockResolvedValue(undefined);
  points=[];env={ENVIRONMENT:'staging',METRICS:{writeDataPoint:(point:AnalyticsEngineDataPoint)=>{points.push(point);}}} as Env;
  message={body:{kind:'expiry'},ack:vi.fn(),retry:vi.fn()};
 });
 async function run(){await worker.queue({messages:[message]} as never,env);}
 it.each([
  ['expiry','cleanup_expiry_failed'],['identity','cleanup_identity_failed'],['metadata','cleanup_auth_metadata_failed'],
  ['webPush','cleanup_web_push_failed'],['nativePush','cleanup_native_push_failed'],['email','cleanup_email_failed'],['heartbeat','cleanup_heartbeat_failed'],
 ] as const)('attributes %s failure without recording error contents or changing retry',async(step,code)=>{
  steps[step].mockRejectedValueOnce(secretError());await run();
  expect(points.map(point=>point.blobs?.[5])).toEqual([code,'cleanup_retry']);
  expect(message.ack).not.toHaveBeenCalled();expect(message.retry).toHaveBeenCalledExactlyOnceWith({delaySeconds:60});
  expect(JSON.stringify(points)).not.toMatch(/private|password|member@example|email-link/);
 });
 it.each(['before','after'] as const)('attributes journal failure %s work separately from its cleanup phases',async(position)=>{
  steps.journal.mockImplementationOnce(async(_env,work)=>{if(position==='after')await work();throw secretError();});await run();
  expect(points.map(point=>point.blobs?.[5])).toEqual(['cleanup_journal_failed','cleanup_retry']);
  expect(message.retry).toHaveBeenCalledExactlyOnceWith({delaySeconds:60});expect(message.ack).not.toHaveBeenCalled();
 });
 it('preserves successful execution and acknowledgement without adding failure events',async()=>{
  await run();expect(points.map(point=>point.blobs?.[5])).toEqual(['cleanup_complete']);
  expect(message.ack).toHaveBeenCalledTimes(1);expect(message.retry).not.toHaveBeenCalled();
 });
 it('identifies acknowledgement failure without replacing the existing retry behavior',async()=>{
  message.ack.mockImplementationOnce(()=>{throw secretError();});await run();
  expect(points.map(point=>point.blobs?.[5])).toEqual(['cleanup_complete','cleanup_ack_failed','cleanup_retry']);
  expect(message.retry).toHaveBeenCalledExactlyOnceWith({delaySeconds:60});
 });
 it('keeps acknowledgement and retry independent of telemetry availability',async()=>{
  env.METRICS={writeDataPoint(){throw secretError();}} as never;await run();expect(message.ack).toHaveBeenCalledTimes(1);
  message.ack.mockClear();steps.expiry.mockRejectedValueOnce(secretError());await run();
  expect(message.ack).not.toHaveBeenCalled();expect(message.retry).toHaveBeenCalledExactlyOnceWith({delaySeconds:60});
 });
 it('routes denial cleanup outside the global privacy journal and exposes only fixed metrics',async()=>{
  message.body.kind='session_denial_cleanup';await run();
  expect(steps.denial).toHaveBeenCalledExactlyOnceWith(env,undefined);expect(steps.journal).not.toHaveBeenCalled();expect(steps.expiry).not.toHaveBeenCalled();
  expect(points.map(point=>point.blobs?.[5])).toEqual(['session_denial_cleanup_complete','session_denial_cleanup_invalid']);
  expect(message.ack).toHaveBeenCalledTimes(1);expect(message.retry).not.toHaveBeenCalled();
 });
 it('sends a bounded continuation before acknowledging its parent and passes its token to cleanup',async()=>{
  const order:string[]=[],send=vi.fn(async()=>{order.push('send');});env.JOBS={send} as never;
  message.body={kind:'session_denial_cleanup',denialProgressEtag:'previous-checkpoint'};
  message.ack.mockImplementation(()=>{order.push('ack');});
  steps.denial.mockResolvedValueOnce({seen:100,deleted:0,invalid:0,advanced:true,continuation:'next-checkpoint'});
  await run();expect(order).toEqual(['send','ack']);
  expect(steps.denial).toHaveBeenCalledExactlyOnceWith(env,'previous-checkpoint');
  expect(send).toHaveBeenCalledExactlyOnceWith({kind:'session_denial_cleanup',denialProgressEtag:'next-checkpoint'});
  expect(steps.journal).not.toHaveBeenCalled();expect(JSON.stringify(points)).not.toMatch(/checkpoint/);
 });
 it('retries an unknown continuation send without acknowledging or opening a global intent',async()=>{
  const send=vi.fn().mockRejectedValueOnce(secretError());env.JOBS={send} as never;
  message.body.kind='session_denial_cleanup';
  steps.denial.mockResolvedValueOnce({seen:100,deleted:0,invalid:0,advanced:true,continuation:'next-checkpoint'});
  await run();expect(send).toHaveBeenCalledTimes(1);expect(message.ack).not.toHaveBeenCalled();
  expect(message.retry).toHaveBeenCalledExactlyOnceWith({delaySeconds:60});expect(steps.journal).not.toHaveBeenCalled();
  expect(JSON.stringify(points)).not.toMatch(/private|password|checkpoint/);
 });
 it('bounds a stalled continuation send and safely retries when its reply arrives late',async()=>{
  let release!:()=>void;const send=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));env.JOBS={send} as never;
  message.body.kind='session_denial_cleanup';steps.denial.mockResolvedValueOnce({seen:100,deleted:0,invalid:0,advanced:true,continuation:'next-checkpoint'});
  vi.useFakeTimers();try{
   const pending=run();await vi.advanceTimersByTimeAsync(5000);await pending;
   expect(message.retry).toHaveBeenCalledExactlyOnceWith({delaySeconds:60});expect(message.ack).not.toHaveBeenCalled();
   release();await vi.advanceTimersByTimeAsync(0);expect(message.ack).not.toHaveBeenCalled();expect(send).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  }finally{release?.();vi.useRealTimers();}
 });
 it('does not enqueue another page for completed passes or stale continuation deliveries',async()=>{
  const send=vi.fn();env.JOBS={send} as never;message.body.kind='session_denial_cleanup';
  steps.denial.mockResolvedValueOnce({seen:0,deleted:0,invalid:0,advanced:false});
  await run();expect(send).not.toHaveBeenCalled();expect(message.ack).toHaveBeenCalledTimes(1);
 });
 it('retries denial cleanup failures without registering a global unfinished intent',async()=>{
  message.body.kind='session_denial_cleanup';steps.denial.mockRejectedValueOnce(secretError());await run();
  expect(steps.journal).not.toHaveBeenCalled();expect(message.ack).not.toHaveBeenCalled();expect(message.retry).toHaveBeenCalledExactlyOnceWith({delaySeconds:60});
  expect(points.map(point=>point.blobs?.[5])).toEqual(['session_denial_cleanup_retry']);expect(JSON.stringify(points)).not.toMatch(/private|password|member@example/);
 });

 it('routes active partition work outside the privacy journal and preserves scoped continuation ordering',async()=>{
  env.SESSION_DENIAL_CLEANUP_V1='true';env.SESSION_DENIAL_PARTITIONS_V1='active';const order:string[]=[];env.JOBS={send:vi.fn(async()=>{order.push('send');})} as never;
  message.body={kind:'session_denial_cleanup_partition',denialPartition:1,denialProgressEtag:'v4:1:old'};message.ack.mockImplementation(()=>{order.push('ack');});
  steps.partition.mockResolvedValueOnce({seen:100,deleted:1,invalid:0,advanced:true,continuation:'v4:1:new'});await run();
  expect(steps.partition).toHaveBeenCalledExactlyOnceWith(env,1,'v4:1:old');expect(steps.denial).not.toHaveBeenCalled();expect(steps.expiry).not.toHaveBeenCalled();expect(steps.journal).not.toHaveBeenCalled();expect(order).toEqual(['send','ack']);
  expect(env.JOBS.send).toHaveBeenCalledExactlyOnceWith({kind:'session_denial_cleanup_partition',denialPartition:1,denialProgressEtag:'v4:1:new'});
 });
 it.each([['active','session_denial_cleanup'],['disabled','session_denial_cleanup_partition']] as const)('acknowledges obsolete %s deliveries without restarting another namespace',async(mode,kind)=>{
  env.SESSION_DENIAL_CLEANUP_V1='true';env.SESSION_DENIAL_PARTITIONS_V1=mode;message.body={kind,denialPartition:0};await run();
  expect(message.ack).toHaveBeenCalledTimes(1);expect(message.retry).not.toHaveBeenCalled();expect(steps.denial).not.toHaveBeenCalled();expect(steps.partition).not.toHaveBeenCalled();expect(steps.expiry).not.toHaveBeenCalled();expect(steps.journal).not.toHaveBeenCalled();
 });
 it.each(['shadow','dual'])('keeps both scan namespaces available in %s mode and rejects unknown mode settings',async mode=>{
  env.SESSION_DENIAL_CLEANUP_V1='true';env.SESSION_DENIAL_PARTITIONS_V1=mode;message.body={kind:'session_denial_cleanup'};await run();message.body={kind:'session_denial_cleanup_partition',denialPartition:2};await run();expect(steps.denial).toHaveBeenCalledTimes(1);expect(steps.partition).toHaveBeenCalledTimes(1);
  env.SESSION_DENIAL_PARTITIONS_V1='invalid';message.ack.mockClear();await run();expect(message.ack).not.toHaveBeenCalled();expect(message.retry).toHaveBeenCalledExactlyOnceWith({delaySeconds:60});expect(steps.partition).toHaveBeenCalledTimes(1);
 });
 it('retries uncertain partition sends without acknowledging or registering a global intent',async()=>{
  env.SESSION_DENIAL_CLEANUP_V1='true';env.SESSION_DENIAL_PARTITIONS_V1='active';env.JOBS={send:vi.fn().mockRejectedValueOnce(secretError())} as never;
  message.body={kind:'session_denial_cleanup_partition',denialPartition:0};steps.partition.mockResolvedValueOnce({seen:100,deleted:0,invalid:0,advanced:true,continuation:'v4:0:next'});await run();
  expect(message.ack).not.toHaveBeenCalled();expect(message.retry).toHaveBeenCalledExactlyOnceWith({delaySeconds:60});expect(steps.journal).not.toHaveBeenCalled();expect(JSON.stringify(points)).not.toMatch(/private|password|checkpoint/);
 });

});
