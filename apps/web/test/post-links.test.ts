import {describe,it,expect} from 'vitest';
import {postTextParts} from '../src/post-links';
describe('post web links',()=>{
 it('preserves the exact posted text and whitespace',()=>{
  const text='Look 👋\nhttps://example.com/a?x=1&y=2, then www.example.org!';
  const parts=postTextParts(text);expect(parts.map(p=>p.text).join('')).toBe(text);
  expect(parts.filter(p=>p.href).map(p=>p.href)).toEqual(['https://example.com/a?x=1&y=2','https://www.example.org/']);
 });
 it('keeps balanced parentheses and IPv6 but excludes surrounding punctuation',()=>{
  expect(postTextParts('(https://example.com/A_(B)). [http://[::1]/x]').filter(p=>p.href).map(p=>p.text)).toEqual(['https://example.com/A_(B)','http://[::1]/x']);
 });
 it('never links unsafe schemes, embedded addresses or invalid URLs',()=>{
  for(const text of ['javascript:alert(1)','data:text/html,test','mailto:a@b.com','javascript:https://example.com','me@www.example.com','https://','http://[bad]'])expect(postTextParts(text).some(p=>p.href)).toBe(false);
 });
 it('supports uppercase schemes, fragments, escaped parameters and Unicode domains',()=>{
  const text='HTTPS://example.org/#a https://example.org/a%20b https://例え.jp/path';
  expect(postTextParts(text).filter(p=>p.href)).toHaveLength(3);expect(postTextParts(text).map(p=>p.text).join('')).toBe(text);
 });
});
