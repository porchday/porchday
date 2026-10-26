import {describe,expect,it} from 'vitest';
import type {EncryptedEnvelope} from '../src/api';
import {profileRefreshState} from '../src/profile-refresh';
const envelope=(revision:number)=>({context:{revision},ciphertext:'synthetic-'+revision}) as EncryptedEnvelope;
describe('profile refresh preserves drafts and their revision base',()=>{
  it('preserves typing before the first empty read completes',()=>{
    const state=profileRefreshState(),read=state.begin();state.edit();
    expect(state.decide(read,null,null)).toBe('preserve');
  });
  it('requires an explicit reload when a saved starter arrives after typing',()=>{
    const state=profileRefreshState(),read=state.begin();state.edit();
    expect(state.decide(read,null,envelope(1))).toBe('conflict');
    expect(state.decide(state.begin(),null,envelope(1))).toBe('conflict');
  });
  it('does not overwrite edits made while decryption is pending',()=>{
    const state=profileRefreshState(),read=state.begin(),saved=envelope(2);
    expect(state.decide(read,saved,saved)).toBe('replace');state.edit();
    expect(state.decide(read,saved,saved)).toBe('preserve');
  });
  it('ignores old reads after a new read, identity cleanup, or a confirmed save',()=>{
    const state=profileRefreshState(),old=state.begin(),current=state.begin();
    expect(state.decide(old,null,envelope(1))).toBe('stale');
    state.invalidate();expect(state.decide(current,null,envelope(1))).toBe('stale');
    const beforeSave=state.begin();state.edit();state.saved();
    expect(state.decide(beforeSave,null,envelope(1))).toBe('stale');
    expect(state.decide(state.begin(),envelope(2),envelope(2))).toBe('replace');
  });
});
