import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {Env} from '../src/types';

const steps=vi.hoisted(()=>({journal:vi.fn(),expiry:vi.fn(),identity:vi.fn(),metadata:vi.fn(),webPush:vi.fn(),nativePush:vi.fn(),email:vi.fn(),heartbeat:vi.fn(),denial:vi.fn()}));
vi.mock('../src/db',async original=>({...await original<typeof import('../src/db')>(),cleanupExpired:steps.expiry}));
vi.mock('../src/privacy-journal',async original=>({...await original<typeof import('../src/privacy-journal')>(),withPrivacyJournal:steps.journal}));
vi.mock('../src/identity-cleanup',()=>({cleanupDeletedIdentities:steps.identity}));
vi.mock('../src/metadata-cleanup',()=>({cleanupAuthenticationMetadata:steps.metadata}));
vi.mock('../src/social-push',async original=>({...await original<typeof import('../src/social-push')>(),processWebPush:steps.webPush}));
vi.mock('../src/social-native-push',async original=>({...await original<typeof import('../src/social-native-push')>(),processNativePush:steps.nativePush}));
vi.mock('../src/email-outbox',async original=>({...await original<typeof import('../src/email-outbox')>(),processAccountEmails:steps.email}));
vi.mock('../src/operations-health',async original=>({...await original<typeof import('../src/operations-health')>(),recordCleanupSuccess:steps.heartbeat}));
vi.mock('../src/session-denial-cleanup',()=>({cleanupDeniedSessions:steps.denial}));
import worker from '../src/index';

describe('Cleanup failure phase diagnostics preserve queue behavior',()=>{
 let points:AnalyticsEngineDataPoint[],env:Env,message:{body:{kind:string};ack:ReturnType<typeof vi.fn>;retry:ReturnType<typeof vi.fn>};
 const secretError=()=>Object.assign(Error('private SQL password=email-link member@example.test'),{code:'private-error-code'});
 beforeEach(()=>{
  for(const step of Object.values(steps))step.mockReset();
  steps.denial.mockResolvedValue({seen:2,deleted:1,invalid:1,advanced:false});
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
  expect(steps.denial).toHaveBeenCalledExactlyOnceWith(env);expect(steps.journal).not.toHaveBeenCalled();expect(steps.expiry).not.toHaveBeenCalled();
  expect(points.map(point=>point.blobs?.[5])).toEqual(['session_denial_cleanup_complete','session_denial_cleanup_invalid']);
  expect(message.ack).toHaveBeenCalledTimes(1);expect(message.retry).not.toHaveBeenCalled();
 });
 it('retries denial cleanup failures without registering a global unfinished intent',async()=>{
  message.body.kind='session_denial_cleanup';steps.denial.mockRejectedValueOnce(secretError());await run();
  expect(steps.journal).not.toHaveBeenCalled();expect(message.ack).not.toHaveBeenCalled();expect(message.retry).toHaveBeenCalledExactlyOnceWith({delaySeconds:60});
  expect(points.map(point=>point.blobs?.[5])).toEqual(['session_denial_cleanup_retry']);expect(JSON.stringify(points)).not.toMatch(/private|password|member@example/);
 });

});
