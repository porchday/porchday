/** Reproducible, nonsecret reaction vectors. No account credentials or network. */
import {createHash, createHmac} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {deflateSync, crc32} from 'node:zlib';
import {UNICODE_EMOJI, canonicalUnicode, LEGACY_REACTIONS} from '../src/reactions.ts';

const chunk = (name: string, data: Uint8Array) => {
  const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
};
const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 24, 160, 80, 127]))), chunk('IEND', Buffer.alloc(0))]);
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const secret = Buffer.from(Array.from({length: 32}, (_, i) => i)).toString('base64url');
const targetId = 'post-reaction-fixture', memberId = 'fixture-alice';
const emoji = (input: string) => {
  const unicode = canonicalUnicode(input);
  if (!unicode) throw Error('Fixture Unicode missing');
  const legacy = LEGACY_REACTIONS.find(entry => entry.unicode === unicode);
  return legacy ? {emoji: legacy.id} : {emoji: 'u1_' + sha(unicode), unicode};
};
const payloads = [
  ...LEGACY_REACTIONS.map(entry => ({name: 'legacy-' + entry.id, payload: {emoji: entry.id}})),
  {name: 'unicode-family', payload: emoji('👨‍👩‍👧‍👦')},
  {name: 'unicode-skin-tone', payload: emoji('👌🏽')},
  {name: 'unicode-country-flag', payload: emoji('🇺🇸')},
  {name: 'unicode-keycap-alias', payload: emoji('1⃣')},
  {name: 'unicode-17-orca', payload: emoji(UNICODE_EMOJI.find(entry => entry.name === 'orca')!.unicode)},
  {name: 'custom-transparent-png', payload: {emoji: 'c1_' + sha(png), custom: {name: 'green_dot', png: png.toString('base64')}}},
];
const vectors = payloads.map(entry => ({...entry, tag: createHmac('sha256', Buffer.from(secret, 'base64url'))
  .update(JSON.stringify({emoji: entry.payload.emoji, memberId, purpose: 'porchday-reaction-v1', targetId})).digest('base64url')}));
await writeFile(new URL('./fixtures/reactions-v1.json', import.meta.url), JSON.stringify({v: 1, secret, targetId, memberId, vectors}, null, 2) + '\n');
console.log(`Wrote ${vectors.length} synthetic reaction interoperability vectors.`);
