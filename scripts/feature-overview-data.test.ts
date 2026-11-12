import {describe,it,expect} from 'vitest';
import {prepareOverviewChanges} from './feature-overview-data';
import {proposalOverview} from '../apps/web/src/feature-presentation';
const entry={id:'00000000-0000-0000-0000-000000000001',original:'Source: public reference\n\nScope: no extra approval is required.\n  Exact whitespace.\n',summary:'Permit one scoped exception to voting.',highlights:['A second approval is not required.']};
describe('reviewed overview migration',()=>{
 it('preserves the complete original byte for byte and has an exact inverse',()=>{
  const [change]=prepareOverviewChanges([entry]);
  expect(change.before).toBe(entry.original);
  expect(proposalOverview(change.after).original).toBe(entry.original);
  expect(Object.keys(change).sort()).toEqual(['after','before','id']);
 });
 it('refuses duplicate IDs and double wrapping',()=>{
  expect(()=>prepareOverviewChanges([entry,entry])).toThrow('DUPLICATE');
  expect(()=>prepareOverviewChanges([{...entry,original:prepareOverviewChanges([entry])[0].after}])).toThrow('ALREADY_WRAPPED');
 });
 it('rejects malformed, oversized or ambiguous presentation instead of truncating',()=>{
  for(const patch of [{summary:'word '.repeat(41)},{summary:'line\nbreak'},{highlights:[]},{highlights:['one','two','three','four']},{original:'x'.repeat(12000)}]) {
   expect(()=>prepareOverviewChanges([{...entry,...patch}])).toThrow();
  }
 });
});
