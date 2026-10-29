import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64ToBytes, bytesToBase64 } from '../src/index.ts';

test('base64 copies every byte exactly across chunk boundaries and fresh buffers', () => {
 for (const length of [0,1,2,3,255,256,8191,8192,8193,1024*1024]) {
  const expected=Uint8Array.from({length},(_,i)=>(i*37+11)%256);
  const encoded=bytesToBase64(expected),first=base64ToBytes(encoded),second=base64ToBytes(encoded);
  assert.deepEqual(first,expected);assert.deepEqual(second,expected);
  assert.notEqual(first.buffer,second.buffer);
  assert.equal(first.byteOffset,0);assert.equal(first.buffer.byteLength,length);
 }
});
test('base64 retains the existing atob acceptance and rejection rules', () => {
 for (const value of ['', 'YQ', 'YQ==', 'YWI', 'YWI=', ' YW\tJj\r\n\f', '/+8=', 'Zh==', 'Zg=', 'A', '====', 'YQ===', '-_8=', 'a\u0000', 'é']) {
  let expected:string;
  try { expected=atob(value); }
  catch { assert.throws(()=>base64ToBytes(value),{name:'InvalidCharacterError'});continue; }
  assert.deepEqual(base64ToBytes(value),Uint8Array.from(expected,c=>c.charCodeAt(0)));
 }
});
