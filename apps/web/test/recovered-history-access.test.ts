import {describe,it,expect} from 'vitest';
import {onlyRecoveredOwnDevicesMissing,hasRecoveredAccess} from '../src/recovered-history-access';
import type {EncryptedEnvelope,Device} from '../src/api';
const old={id:'old',member_id:'me',fingerprint:'old-fp'} as Device,newOwn={id:'new',member_id:'me',fingerprint:'new-fp'} as Device,peer={id:'peer',member_id:'friend',fingerprint:'peer-fp'} as Device;
const envelope={recipients:[{deviceId:old.id,memberId:old.member_id,fingerprint:old.fingerprint},{deviceId:peer.id,memberId:peer.member_id,fingerprint:peer.fingerprint}]} as EncryptedEnvelope;
describe('recovered own-device history',()=>{
 it('skips only an own-device gap covered by recovered keys',()=>{expect(onlyRecoveredOwnDevicesMissing(envelope,[old,newOwn,peer],'me',new Set(['old-fp','new-fp']),true)).toBe(true);});
 it('does not suppress a new peer or changed peer fingerprint',()=>{for(const next of [{...peer,id:'peer2'},{...peer,fingerprint:'rotated'}])expect(onlyRecoveredOwnDevicesMissing(envelope,[old,newOwn,next],'me',new Set(['old-fp']),true)).toBe(false);});
 it('retains catch-up if historical keys are unavailable, or a recipient-table repair is needed',()=>{expect(onlyRecoveredOwnDevicesMissing(envelope,[old,newOwn,peer],'me',new Set(['new-fp']),true)).toBe(false);expect(onlyRecoveredOwnDevicesMissing(envelope,[old,peer],'me',new Set(['old-fp']),true)).toBe(false);});
 it('does not skip unknown or missing server grants even with all old keys',()=>{for(const coverage of [false,undefined])expect(onlyRecoveredOwnDevicesMissing(envelope,[old,newOwn,peer],'me',new Set(['old-fp']),coverage)).toBe(false);});
 it('requires own coverage independently for each attachment, not a peer key',()=>{expect(hasRecoveredAccess(envelope,'me',new Set(['peer-fp']))).toBe(false);expect(hasRecoveredAccess({...envelope,recipients:[{deviceId:'lost',memberId:'me',fingerprint:'lost-fp'}]},'me',new Set(['old-fp']))).toBe(false);});
});
