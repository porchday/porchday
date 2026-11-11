import {describe,it,expect} from 'vitest';
import {handleTokens,resolveMentionTags} from './mentions';
const alice={id:'00000000-0000-4000-8000-000000000001',kind:'member' as const,label:'alice'};
const bob={id:'00000000-0000-4000-8000-000000000002',kind:'member' as const,label:'bob'};
describe('typed encrypted people tags',()=>{
 it('recognizes whole case-insensitive handles with punctuation and newlines',()=>{
  expect(handleTokens('Hi @Alice, (@bob)!\n@alice').map(t=>t.handle)).toEqual(['alice','bob','alice']);
 });
 it('ignores email addresses, escaped handles, URLs, short and overlong identifiers',()=>{
  expect(handleTokens('mail@alice.com \\@alice https://x.test/?@alice www.x.test/?@bob @ab @abcdefghijklmnopqrstuvwxyz')).toEqual([]);
 });
 it('merges and deduplicates typed and selected identities',()=>{
  expect(resolveMentionTags('@alice @alice @bob @unknown',[bob],[alice,bob])).toEqual([bob,{...alice,source:'mention'}]);
 });
 it('removes deleted typed references while preserving explicitly selected people',()=>{
  expect(resolveMentionTags('text',[{...alice,source:'mention'},bob],[alice,bob])).toEqual([bob]);
 });
 it('preserves a renamed identity rather than resolving a reassigned old handle',()=>{
  expect(resolveMentionTags('@alice',[{...alice,source:'mention'}],[{...alice,label:'renamed'},{...bob,label:'alice'}])).toEqual([{...alice,source:'mention'}]);
 });
 it('does not resolve unknown, blocked or unavailable people or child labels as accounts',()=>{
  expect(resolveMentionTags('@alice @kid',[{...alice,source:'mention'}],[{...bob,kind:'child',label:'kid'}])).toEqual([]);
 });
 it('enforces the shared tag limit without silent truncation',()=>{
  expect(()=>resolveMentionTags('@alice',Array.from({length:30},(_,i)=>({...bob,id:String(i)})),[alice])).toThrow('at most 30');
 });
});
