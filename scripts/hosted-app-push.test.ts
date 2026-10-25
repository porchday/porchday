import { describe, it, expect } from 'vitest';
import { assertInitialPair, assertOutboxEvidence, bounded, explicitAttempt, isExpectedNotification, mutationKind } from './hosted-app-push-support.js';
const aId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', subscriptionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const boundary = { aId, bId, aHandle: 'qa_fixture_0', requestId, subscriptionId, cleanup: false };
function pair() {
  const row = (id: string, blocks: any[]) => ({ me: { id, status: 'active', notification_preferences: { in_app: true, push: false } },
    blocks: { items: blocks }, connections: { items: [], requests: [] }, subscriptions: { items: [] } });
  return [row(aId, [{ target: bId }]), row(bId, [])];
}
describe('bounded application push verification', () => {
  it('a hung browser operation times out so cleanup can continue, with late rejection handled', async () => {
    let reject!: (reason: Error) => void;
    const work = new Promise<void>((_,fail) => {reject=fail;});
    await expect(bounded(work,5,'BROWSER_TIMEOUT')).rejects.toThrow('BROWSER_TIMEOUT');
    reject(new Error('private browser diagnostics must never escape'));
    await new Promise(resolve => setTimeout(resolve,5));
    expect(await bounded(Promise.resolve('cleanup continued'),20,'UNUSED')).toBe('cleanup continued');
  });
  it('requires an explicit unique attempt before any fixture/network access', () => {
    expect(explicitAttempt(['--run', '--attempt=1234abcd'])).toBe('1234abcd');
    for (const args of [[], ['--run'], ['--attempt=1234abcd'], ['--run', '--attempt=1234abcd', '--retry']]) {
      expect(() => explicitAttempt(args)).toThrow('EXPLICIT_ATTEMPT_REQUIRED');
    }
  });
  it('refuses changed account, block, preference, relationship and subscription preconditions', () => {
    const [a,b] = pair(); expect(() => assertInitialPair(a,b,aId,bId)).not.toThrow();
    for (const alter of [
      (x:any) => x.me.status = 'held', (x:any) => x.blocks.items = [],
      (x:any) => x.me.notification_preferences.push = true,
      (x:any) => x.connections.items = [{ member_a: aId, member_b: bId }],
      (x:any) => x.connections.requests = [{ sender: bId, recipient: aId }],
      (x:any) => x.subscriptions.items = [{ id: subscriptionId }],
    ]) { const [changed,other] = pair(); alter(changed); expect(() => assertInitialPair(changed,other,aId,bId)).toThrow(); }
  });
  it('cannot accept a friendship, change another block, write content or register during cleanup', () => {
    expect(mutationKind('A','DELETE',`/api/v1/blocks/${bId}`,{},boundary)).toBe('unblock');
    expect(mutationKind('B','POST','/api/v1/connections/requests',{id:requestId,kind:'friend',handle:'qa_fixture_0'},boundary)).toBe('friend-request');
    for (const [who,method,path,body,b] of [
      ['B','POST',`/api/v1/connections/requests/${requestId}/accept`,{},boundary],
      ['A','DELETE',`/api/v1/blocks/${requestId}`,{},boundary],
      ['A','POST','/api/v1/posts',{},boundary],
      ['A','POST','/api/v1/push/subscriptions',{}, {...boundary,cleanup:true}],
      ['A','DELETE',`/api/v1/blocks/${bId}`,{}, {...boundary,cleanup:true}],
    ] as const) expect(() => mutationKind(who,method,path,body,b)).toThrow('MUTATION_BOUNDARY');
  });
  it('cleanup is constrained to captured IDs and exact previous preferences', () => {
    const b = {...boundary,cleanup:true};
    expect(mutationKind('A','PUT',`/api/v1/blocks/${bId}`,{},b)).toBe('restore-block');
    expect(mutationKind('A','DELETE',`/api/v1/push/subscriptions/${subscriptionId}`,{},b)).toBe('revoke-push');
    expect(() => mutationKind('A','DELETE','/api/v1/push/subscriptions',{},b)).toThrow();
    expect(() => mutationKind('A','PATCH','/api/v1/me',{notification_preferences:{in_app:false,push:false}},b)).toThrow();
  });
  it('matches the actual request notification and requires independent sent-outbox evidence', () => {
    const n = {id:subscriptionId,recipient:aId,actor:bId,kind:'connection_request',dedupe_key:`request:${requestId}`,
      post_id:null,comment_id:null,group_id:null,read_at:null};
    expect(isExpectedNotification(n,boundary)).toBe(true);
    expect(isExpectedNotification({...n,actor:aId},boundary)).toBe(false);
    expect(isExpectedNotification({...n,dedupe_key:'request:old'},boundary)).toBe(false);
    expect(() => assertOutboxEvidence({attempt:'1234abcd',matched:1,outcome:'sent',completed:true,attempts:1},'1234abcd')).not.toThrow();
    for (const v of [{attempt:'other'}, {attempt:'1234abcd',matched:1,outcome:'retry',completed:false,attempts:1}]) {
      expect(() => assertOutboxEvidence(v,'1234abcd')).toThrow('OUTBOX_EVIDENCE_UNCONFIRMED');
    }
  });
});
