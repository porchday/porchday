import dataset from '../data/emoji-17.0.json' with {type: 'json'};

export const CUSTOM_EMOJI_MAX_BYTES = 32768;
export const CUSTOM_EMOJI_MAX_DIMENSION = 128;
export const UNICODE_EMOJI_VERSION = '17.0';
export interface UnicodeEmoji {
  readonly unicode: string;
  readonly name: string;
  readonly group: string;
  readonly subgroup: string;
  readonly version: string;
  readonly aliases: readonly string[];
}
export const UNICODE_EMOJI: readonly UnicodeEmoji[] = Object.freeze(dataset.emojis.map(
  entry => Object.freeze({...entry, aliases: Object.freeze([...entry.aliases])}),
));
export const LEGACY_REACTIONS = Object.freeze([
  {id: 'like', unicode: '👍', label: 'Like'},
  {id: 'love', unicode: '❤️', label: 'Love'},
  {id: 'laugh', unicode: '😄', label: 'Laugh'},
  {id: 'celebrate', unicode: '🎉', label: 'Celebrate'},
  {id: 'care', unicode: '🤗', label: 'Care'},
  {id: 'sunshine', unicode: '☀️', label: 'Sunshine'},
].map(entry => Object.freeze(entry))) as readonly {
  readonly id: 'like' | 'love' | 'laugh' | 'celebrate' | 'care' | 'sunshine';
  readonly unicode: string; readonly label: string;
}[];
export type LegacyReactionId = typeof LEGACY_REACTIONS[number]['id'];
export type ReactionPayload =
  | {emoji: LegacyReactionId}
  | {emoji: string; unicode: string}
  | {emoji: string; custom: {name: string; png: string}};

const aliasLookup = new Map<string, UnicodeEmoji>();
for (const entry of UNICODE_EMOJI) for (const alias of entry.aliases) aliasLookup.set(alias, entry);
const legacyById = new Map(LEGACY_REACTIONS.map(entry => [entry.id as string, entry]));
const legacyByUnicode = new Map(LEGACY_REACTIONS.map(entry => [entry.unicode, entry]));
const encoder = new TextEncoder();
const fail = (message = 'Invalid reaction'): never => {throw new Error(message);};

/** Exact pinned Unicode aliases only. Never synthesize ZWJ or modifier forms. */
export function unicodeMetadata(input: string): UnicodeEmoji | null {
  if (typeof input !== 'string' || input.length > 128 || encoder.encode(input).length > 256) return null;
  return aliasLookup.get(input.normalize('NFC')) ?? null;
}
export function canonicalUnicode(input: string): string | null {return unicodeMetadata(input)?.unicode ?? null;}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map(
    byte => byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function unicodeReaction(input: string): Promise<ReactionPayload> {
  const unicode = canonicalUnicode(input);
  if (!unicode) return fail('Choose one recognized Unicode emoji');
  const legacy = legacyByUnicode.get(unicode);
  if (legacy) return {emoji: legacy.id};
  return {emoji: 'u1_' + await sha256(encoder.encode(unicode)), unicode};
}

const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Structural validation only; recipients must ALSO decode the bounded image
 * using their platform image decoder before displaying it. No SVG, APNG,
 * compressed profiles/text, trailing data, or unrecognized metadata is accepted.
 */
export function validateCustomPng(bytes: Uint8Array): {width: number; height: number} {
  if (!(bytes instanceof Uint8Array) || bytes.length < 57 || bytes.length > CUSTOM_EMOJI_MAX_BYTES)
    return fail('Custom emoji PNG exceeds its size limit');
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte))
    return fail('Custom emoji must be a static PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0, color = -1, depth = 0, palette = 0, dataBytes = 0;
  let ended = false, hasData = false;
  const seen = new Set<string>();
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return fail('Invalid PNG chunk');
    const length = view.getUint32(offset), start = offset + 8, end = start + length;
    if (length > CUSTOM_EMOJI_MAX_BYTES || end + 4 > bytes.length) return fail('Invalid PNG chunk');
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, start));
    if (!['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(kind))
      return fail('Unsupported or animated PNG');
    if (crc32(bytes.subarray(offset + 4, end)) !== view.getUint32(end)) return fail('Invalid PNG checksum');
    if ((!seen.size && kind !== 'IHDR') || (kind !== 'IDAT' && seen.has(kind))) return fail('Invalid PNG order');
    if (hasData && kind !== 'IDAT' && kind !== 'IEND') return fail('Invalid PNG order');
    if (kind === 'IHDR') {
      if (offset !== 8 || length !== 13) return fail('Invalid PNG header');
      width = view.getUint32(start); height = view.getUint32(start + 4);
      depth = bytes[start + 8]; color = bytes[start + 9];
      const depths: Record<number, number[]> = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
      if (!width || !height || width > CUSTOM_EMOJI_MAX_DIMENSION || height > CUSTOM_EMOJI_MAX_DIMENSION
        || !depths[color]?.includes(depth) || bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || bytes[start + 12] > 1)
        return fail('Invalid or oversized PNG dimensions');
    } else if (kind === 'PLTE') {
      if ([0, 4].includes(color) || seen.has('tRNS') || !length || length % 3 || length > 768
        || (color === 3 && length / 3 > 2 ** depth)) return fail('Invalid PNG palette');
      palette = length / 3;
    } else if (kind === 'tRNS') {
      if (!(color === 0 && length === 2 || color === 2 && length === 6 || color === 3 && palette > 0 && length > 0 && length <= palette))
        return fail('Invalid PNG transparency');
    } else if (kind === 'IDAT') {
      if (color === 3 && !palette) return fail('Missing PNG palette');
      hasData = true; dataBytes += length;
    } else if (kind === 'IEND') {
      if (length !== 0 || !hasData || !dataBytes || end + 4 !== bytes.length) return fail('Invalid PNG ending');
      ended = true;
    } else {
      if (kind !== 'pHYs' && seen.has('PLTE')) return fail('Invalid PNG color metadata order');
      if (kind === 'sRGB' && (length !== 1 || bytes[start] > 3)
        || kind === 'gAMA' && (length !== 4 || view.getUint32(start) === 0)
        || kind === 'cHRM' && length !== 32
        || kind === 'pHYs' && (length !== 9 || bytes[start + 8] > 1)) return fail('Invalid PNG metadata');
    }
    seen.add(kind); offset = end + 4;
  }
  if (!ended) return fail('Incomplete PNG');
  return {width, height};
}

function encodeBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export function customPngBytes(encoded: string): Uint8Array {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(CUSTOM_EMOJI_MAX_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return fail('Invalid custom emoji encoding');
  let decoded: string;
  try {decoded = atob(encoded);} catch {return fail('Invalid custom emoji encoding');}
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  if (encodeBase64(bytes) !== encoded) return fail('Noncanonical custom emoji encoding');
  validateCustomPng(bytes);
  return bytes;
}
export async function customReaction(name: string, png: Uint8Array): Promise<ReactionPayload> {
  if (typeof name !== 'string' || !/^[a-z0-9_]{1,32}$/.test(name)) return fail('Use a short lowercase emoji name');
  if (!(png instanceof Uint8Array) || png.length > CUSTOM_EMOJI_MAX_BYTES) return fail('Custom emoji PNG exceeds its size limit');
  const bytes = Uint8Array.from(png);
  validateCustomPng(bytes);
  return {emoji: 'c1_' + await sha256(bytes), custom: {name, png: encodeBase64(bytes)}};
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
/** Call after verifying/decrypting the signed envelope, before verifying its
 * target/member HMAC or using an image. Unknown descriptors fail closed.
 */
export async function validateReactionPayload(value: unknown): Promise<ReactionPayload> {
  if (!record(value) || typeof value.emoji !== 'string') return fail();
  if (legacyById.has(value.emoji)) {
    if (!exactKeys(value, ['emoji'])) return fail();
    return {emoji: value.emoji as LegacyReactionId};
  }
  if (/^u1_[a-f0-9]{64}$/.test(value.emoji)) {
    if (!exactKeys(value, ['emoji', 'unicode']) || typeof value.unicode !== 'string'
      || canonicalUnicode(value.unicode) !== value.unicode) return fail();
    const canonical = await unicodeReaction(value.unicode);
    if (canonical.emoji !== value.emoji) return fail('Reaction identity mismatch');
    return canonical;
  }
  if (/^c1_[a-f0-9]{64}$/.test(value.emoji)) {
    if (!exactKeys(value, ['emoji', 'custom']) || !record(value.custom) || !exactKeys(value.custom, ['name', 'png'])
      || typeof value.custom.name !== 'string' || typeof value.custom.png !== 'string') return fail();
    const canonical = await customReaction(value.custom.name, customPngBytes(value.custom.png));
    if (canonical.emoji !== value.emoji) return fail('Reaction identity mismatch');
    return canonical;
  }
  return fail();
}
/** Display only descriptors already accepted by validateReactionPayload. */
export function reactionDisplay(payload: ReactionPayload): {unicode: string | null; name: string; png: string | null} {
  const legacy = legacyById.get(payload.emoji);
  if (legacy) return {unicode: legacy.unicode, name: legacy.label, png: null};
  if ('unicode' in payload) return {unicode: payload.unicode, name: unicodeMetadata(payload.unicode)?.name ?? 'Emoji', png: null};
  if ('custom' in payload) return {unicode: null, name: payload.custom.name, png: payload.custom.png};
  return fail();
}
