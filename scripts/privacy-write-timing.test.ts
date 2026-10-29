import {describe,it,expect} from 'vitest';
import {privacyWriteTiming} from './privacy-write-timing';
import {JOURNAL_PHASES} from '../apps/api/src/journal-phases';
describe('privacy write trace collection',()=>{
 it('retains R2 names containing digits and repeated nested spans without summing parents',()=>{
  expect(privacyWriteTiming('pd-span;dur=42.5;desc="privacy_r2_read@10", pd-span;dur=80;desc="privacy_r2_write@52.5", pd-span;dur=5;desc="privacy_r2_read@132.5", pd-span;dur=127.5;desc="privacy_checkpoint@10"')).toEqual([
   {name:'privacy_r2_read',durationMs:42.5,startMs:10},{name:'privacy_r2_write',durationMs:80,startMs:52.5},
   {name:'privacy_r2_read',durationMs:5,startMs:132.5},{name:'privacy_checkpoint',durationMs:127.5,startMs:10},
  ]);
 });
 it('covers every emitted journal phase',()=>{
  const phases=JOURNAL_PHASES.map(name=>'privacy_'+name);
  expect(privacyWriteTiming(phases.map(name=>`pd-span;dur=0;desc="${name}@1"`).join(', ')).map(s=>s.name)).toEqual(phases);
 });
 it('drops unknown names and private trace, route and error metadata',()=>{
  expect(privacyWriteTiming('pd-trace;desc="secret", pd-route;desc="/private", pd-error;desc="private", pd-span;dur=1;desc="privacy_member_secret@0", pd-span;dur=1;desc="sql_private@0"')).toEqual([]);
 });
 it('rejects malformed and unbounded numbers and leaves missing evidence empty',()=>{
  const bad=['-1','NaN','Infinity','1e5','1.2.3','3600001','9'.repeat(400)];
  for(const value of bad){
   expect(privacyWriteTiming(`pd-span;dur=${value};desc="privacy_work@0"`)).toEqual([]);
   expect(privacyWriteTiming(`pd-span;dur=1;desc="privacy_work@${value}"`)).toEqual([]);
  }
  expect(privacyWriteTiming(null)).toEqual([]);
  expect(privacyWriteTiming('pd-span;dur=1;desc="privacy_r2_read@0" trailing')).toEqual([]);
 });
});
