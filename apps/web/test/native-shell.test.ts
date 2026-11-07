import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock('../src/api', () => api);
import { enableCurrentPush, refreshNativePush, unsubscribeCurrentPush, currentPushStatus } from '../src/push';
import { nativeBadge, nativeForeground } from '../src/native-shell';
let handler: ReturnType<typeof vi.fn>;
let storage: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks(); storage = new Map();
  handler = vi.fn().mockResolvedValue({ token: 'a'.repeat(64), environment: 'production' });
  vi.stubGlobal('window', { webkit: { messageHandlers: { porchday: { postMessage: handler } } } });
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k,v), removeItem: (k: string) => storage.delete(k) });
  api.get.mockResolvedValue({ enabled: true }); api.post.mockResolvedValue({ id: 'subscription' }); api.del.mockResolvedValue({ ok: true });
});
afterEach(() => vi.unstubAllGlobals());
describe('native shell notification bridge', () => {
  it('enrolls through the existing authenticated API only after explicit permission', async () => {
    await enableCurrentPush('member');
    expect(handler).toHaveBeenCalledWith({ version: 1, command: 'push', requestPermission: true });
    expect(api.post).toHaveBeenCalledWith('/native-push/subscriptions', { token: 'a'.repeat(64), environment: 'production' });
    expect(storage.get('porchday-native-push-subscription')).not.toContain('a'.repeat(64));
  });
  it('does not enroll an invalid token or disabled provider', async () => {
    handler.mockResolvedValueOnce({ token: 'bad', environment: 'production' });
    await expect(enableCurrentPush('member')).rejects.toThrow(); expect(api.post).not.toHaveBeenCalled();
    api.get.mockResolvedValueOnce({ enabled: false });
    await expect(enableCurrentPush('member')).rejects.toThrow();
  });
  it('never re-enables a server-revoked opt-in during refresh', async () => {
    storage.set('porchday-native-push-subscription', JSON.stringify({ memberId:'member', id:'old' }));
    api.get.mockResolvedValueOnce({ items: [] }); await refreshNativePush('member');
    expect(handler).toHaveBeenCalledWith({version:1,command:'clear'}); expect(api.post).not.toHaveBeenCalled();
  });
  it('cancels pending enrollment on logout and clears native state even if removal fails', async () => {
    let release!: (v:unknown)=>void;
    handler.mockImplementationOnce(() => new Promise(resolve => release=resolve));
    const enabled = enableCurrentPush('member'); await vi.waitFor(()=>expect(handler).toHaveBeenCalled());
    storage.set('porchday-native-push-subscription', JSON.stringify({memberId:'member',id:'old'}));
    api.del.mockRejectedValueOnce(new Error('offline')); await unsubscribeCurrentPush();
    release({token:'a'.repeat(64),environment:'production'});
    await expect(enabled).rejects.toThrow('cancelled'); expect(api.post).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith({version:1,command:'clear'});
  });
  it('forwards bounded integer badge updates and background visibility', async () => {
    nativeBadge(5); nativeBadge(-1); nativeBadge(2.5);
    expect(handler).toHaveBeenCalledTimes(1); expect(handler).toHaveBeenCalledWith({version:1,command:'badge',count:5});
    expect(nativeForeground()).toBe(true); (window as any).porchdayNativeActive=false; expect(nativeForeground()).toBe(false);
  });
});

describe('device-specific push status', () => {
  function stored(memberId = 'member') { storage.set('porchday-native-push-subscription', JSON.stringify({memberId,id:'subscription'})); }
  it('does not mistake account opt-in or another member for device enrollment', async () => {
    expect(await currentPushStatus('member')).toBe('off');
    stored('other'); expect(await currentPushStatus('member')).toBe('off');
    expect(api.get).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });
  it('requires a matching current-session server subscription and global opt-in', async () => {
    stored();
    for (const [current_session,push,expected] of [[true,true,'enabled'],[false,true,'off'],[true,false,'off']] as const) {
      api.get.mockImplementation(async path => path === '/me' ? {notification_preferences:{push}} : {items:[{id:'subscription',current_session}]});
      expect(await currentPushStatus('member')).toBe(expected);
    }
    expect(handler).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  });
  it('does not claim enabled when revoked or when the server cannot be checked', async () => {
    stored(); api.get.mockResolvedValue({items:[],notification_preferences:{push:true}});
    expect(await currentPushStatus('member')).toBe('off');
    api.get.mockRejectedValue(new Error('offline'));
    await expect(currentPushStatus('member')).rejects.toThrow('offline');
  });
  it('explains unsupported and blocked browsers without asking permission', async () => {
    vi.stubGlobal('window', {}); expect(await currentPushStatus('member')).toBe('unsupported');
    vi.stubGlobal('window', {Notification:{},PushManager:{}});
    vi.stubGlobal('navigator',{serviceWorker:{}}); vi.stubGlobal('Notification',{permission:'denied'});
    expect(await currentPushStatus('member')).toBe('blocked'); expect(api.get).not.toHaveBeenCalled();
  });
  it('requires a live browser subscription as well as stored metadata', async () => {
    vi.stubGlobal('window',{Notification:{},PushManager:{}}); vi.stubGlobal('Notification',{permission:'granted'});
    const subscription=vi.fn().mockResolvedValue(null);
    vi.stubGlobal('navigator',{serviceWorker:{getRegistration:async()=>({pushManager:{getSubscription:subscription}})}});
    storage.set('porchday-push-subscription',JSON.stringify({memberId:'member',id:'subscription'}));
    expect(await currentPushStatus('member')).toBe('off');
    subscription.mockResolvedValue({}); api.get.mockImplementation(async path=>path==='/me'?{notification_preferences:{push:true}}:{items:[{id:'subscription',current_session:true}]});
    expect(await currentPushStatus('member')).toBe('enabled');
  });
});
