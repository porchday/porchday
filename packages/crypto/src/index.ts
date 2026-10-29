/**
 * Porchday's application envelope uses standard RFC 9580 OpenPGP packets.
 * This module has not undergone an independent security review. Do not claim otherwise.
 */
import * as pgp from 'openpgp';

export type UnlockedPrivateKey = pgp.PrivateKey;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ContentKind = 'post' | 'comment' | 'reaction' | 'profile' | 'group' | 'media' | 'report' | 'export';
export type Audience = 'connections' | 'friends' | 'family' | 'only_me' | 'group' | 'moderators';
export interface ContentContext {
  id: string;
  kind: ContentKind;
  authorId: string;
  authorDeviceId: string;
  audience: Audience;
  parentId: string | null;
  groupId: string | null;
  epoch: number;
  createdAt: string;
  expiresAt: string | null;
  revision: number;
}
export interface Recipient {
  memberId: string;
  deviceId: string;
  publicKey: string;
}
export interface RecipientReference {
  memberId: string;
  deviceId: string;
  fingerprint: string;
}
export interface EncryptedEnvelope {
  v: 1;
  protocol: 'porchday-openpgp-v1';
  context: ContentContext;
  recipients: RecipientReference[];
  ciphertext: string;
}
export interface DeviceKeys {
  publicKey: string;
  encryptedPrivateKey: string;
  recoverySecret: string;
  fingerprint: string;
}
export interface DeviceAuthorization {
  v: 1;
  purpose: 'porchday-device-authorization';
  memberId: string;
  authorizingDeviceId: string;
  deviceId: string;
  fingerprint: string;
  challenge: string;
  expiresAt: string;
}
export interface SignedStatement<T> { statement: T; signature: string }

export const PROTOCOL = 'porchday-openpgp-v1' as const;
export const MAX_PLAINTEXT_BYTES = 30 * 1024 * 1024;
export const MAX_CIPHERTEXT_CHARACTERS = 44 * 1024 * 1024;
export const MAX_RECIPIENT_DEVICES = 4000;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const CONFIG: Partial<pgp.Config> = {
  v6Keys: true,
  aeadProtect: true,
  preferredSymmetricAlgorithm: pgp.enums.symmetric.aes256,
  preferredAEADAlgorithm: pgp.enums.aead.gcm,
  preferredCompressionAlgorithm: pgp.enums.compression.uncompressed,
  allowUnauthenticatedMessages: false,
  allowUnauthenticatedStream: false,
  maxDecompressedMessageSize: MAX_PLAINTEXT_BYTES,
};

/** Deterministic JSON for signed statements. Rejects values JSON would silently drop. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(v: unknown): string {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || v === null) throw new Error('Unsupported JSON value');
    if (seen.has(v)) throw new Error('Cyclic JSON is not supported');
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) result = '[' + v.map(encode).join(',') + ']';
    else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('Only plain JSON objects are supported');
      result = '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + encode((v as Record<string, unknown>)[k])).join(',') + '}';
    }
    seen.delete(v);
    return result;
  }
  return encode(value);
}

function checkId(value: string, label: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${label}`);
}
function checkDate(value: string, label: string): number {
  const n = Date.parse(value);
  if (!Number.isFinite(n) || new Date(n).toISOString() !== value) throw new Error(`Invalid ${label}: expected canonical UTC ISO date`);
  return n;
}
export function validateContext(c: ContentContext, now = Date.now()): void {
  checkId(c.id, 'content ID'); checkId(c.authorId, 'author ID'); checkId(c.authorDeviceId, 'device ID');
  if (!['post', 'comment', 'reaction', 'profile', 'group', 'media', 'report', 'export'].includes(c.kind)) throw new Error('Invalid content kind');
  if (!['connections', 'friends', 'family', 'only_me', 'group', 'moderators'].includes(c.audience)) throw new Error('Invalid audience');
  if (c.parentId !== null) checkId(c.parentId, 'parent ID');
  if (c.groupId !== null) checkId(c.groupId, 'group ID');
  if (!Number.isSafeInteger(c.epoch) || c.epoch < 0 || !Number.isSafeInteger(c.revision) || c.revision < 1) throw new Error('Invalid epoch or revision');
  const created = checkDate(c.createdAt, 'creation time');
  if (created > now + 5 * 60_000) throw new Error('Content is from the future');
  if (c.expiresAt !== null) {
    const expiry = checkDate(c.expiresAt, 'expiry');
    if (expiry <= created) throw new Error('Expiry must follow creation');
    if (expiry <= now) throw new Error('Content has expired');
  }
}
function checkSecret(secret: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Recovery secret must be the generated 256-bit secret');
}
export function randomSecret(): string { return bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export const createRecoverySecret = randomSecret;
export const createReactionSecret = randomSecret;

/** Generate on a member device; neither recoverySecret nor unlocked keys may go to the API. */
export async function generateDeviceKeys(memberId: string, deviceId: string, recoverySecret = randomSecret()): Promise<DeviceKeys> {
  checkId(memberId, 'member ID'); checkId(deviceId, 'device ID'); checkSecret(recoverySecret);
  const keys = await pgp.generateKey({ type: 'curve25519', userIDs: [{ name: `Porchday ${memberId}/${deviceId}` }], passphrase: recoverySecret, format: 'armored', config: CONFIG });
  return { publicKey: keys.publicKey, encryptedPrivateKey: keys.privateKey, recoverySecret, fingerprint: await fingerprint(keys.publicKey) };
}
export async function fingerprint(publicKey: string): Promise<string> {
  const key = await pgp.readKey({ armoredKey: publicKey, config: CONFIG });
  if (key.isPrivate()) throw new Error('Public directory keys must not contain private key material');
  await key.verifyPrimaryKey();
  if (key.keyPacket.version !== 6) throw new Error('Porchday requires RFC9580 v6 keys');
  return key.getFingerprint();
}

/** Server-safe validation of a protected backup; never decrypts or returns private material. */
export async function validateEncryptedPrivateKey(armoredKey: string, expectedFingerprint?: string): Promise<void> {
  if (typeof armoredKey !== 'string' || armoredKey.length > 30_000) throw new Error('Invalid protected private-key backup');
  const key = await pgp.readPrivateKey({ armoredKey, config: CONFIG });
  if (key.keyPacket.version !== 6 || key.getKeys().some(part => part.keyPacket.isDecrypted())) throw new Error('Every private key packet must be encrypted');
  await key.verifyPrimaryKey();
  if (expectedFingerprint && key.getFingerprint() !== expectedFingerprint) throw new Error('Protected backup fingerprint mismatch');
}

export function displayFingerprint(value: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error('Invalid fingerprint');
  return value.toUpperCase().match(/.{1,4}/g)!.join(' ');
}
export async function unlockPrivateKey(encryptedPrivateKey: string, recoverySecret: string, expectedFingerprint?: string): Promise<UnlockedPrivateKey> {
  checkSecret(recoverySecret);
  const locked = await pgp.readPrivateKey({ armoredKey: encryptedPrivateKey, config: CONFIG });
  if (locked.isDecrypted()) throw new Error('Refusing an unprotected private-key backup');
  const key = await pgp.decryptKey({ privateKey: locked, passphrase: recoverySecret, config: CONFIG });
  // OpenPGP.js decryptKey validates the decrypted private/public key correspondence.
  if (expectedFingerprint && key.getFingerprint() !== expectedFingerprint) throw new Error('Recovered key does not match the trusted fingerprint');
  return key;
}
export async function protectPrivateKey(privateKey: UnlockedPrivateKey, recoverySecret: string): Promise<string> {
  checkSecret(recoverySecret);
  return (await pgp.encryptKey({ privateKey, passphrase: recoverySecret, config: CONFIG })).armor();
}

export async function encryptObject<T>({ context, payload, signingKey, recipients }: {
  context: ContentContext; payload: T; signingKey: UnlockedPrivateKey; recipients: Recipient[];
}): Promise<EncryptedEnvelope> {
  validateContext(context);
  if (!signingKey.isDecrypted()) throw new Error('Signing key is locked');
  if (recipients.length === 0 || recipients.length > MAX_RECIPIENT_DEVICES) throw new Error('Invalid recipient count');
  const ordered = [...recipients].sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
  const seenDevices = new Set<string>();
  const keys = await Promise.all(ordered.map(async r => {
    checkId(r.memberId, 'recipient member'); checkId(r.deviceId, 'recipient device');
    if (seenDevices.has(r.deviceId)) throw new Error('Duplicate recipient device');
    seenDevices.add(r.deviceId);
    const key = await pgp.readKey({ armoredKey: r.publicKey, config: CONFIG });
    if (key.isPrivate()) throw new Error('Recipient key must be public');
    await key.verifyPrimaryKey();
    if (key.keyPacket.version !== 6) throw new Error('Porchday requires RFC9580 v6 recipient keys');
    return key;
  }));
  const references = ordered.map((r, i) => ({ memberId: r.memberId, deviceId: r.deviceId, fingerprint: keys[i].getFingerprint() }));
  if (!references.some(r => r.memberId === context.authorId && r.deviceId === context.authorDeviceId && r.fingerprint === signingKey.getFingerprint())) throw new Error('The signing device must be a recipient');
  const binding = { v: 1 as const, protocol: PROTOCOL, context, recipients: references };
  const plaintext = canonicalJson({ ...binding, payload });
  if (ENCODER.encode(plaintext).byteLength > MAX_PLAINTEXT_BYTES) throw new Error('Content exceeds encryption size limit');
  const ciphertext = await pgp.encrypt({ message: await pgp.createMessage({ text: plaintext }), encryptionKeys: keys, signingKeys: signingKey, format: 'armored', config: CONFIG });
  return { ...binding, ciphertext };
}

/** expectedContext MUST be derived from the requested resource and validated API metadata. */
export async function decryptObject<T = Json>({ envelope, expectedContext, privateKey, authorPublicKey, now = Date.now() }: {
  envelope: EncryptedEnvelope; expectedContext: ContentContext; privateKey: UnlockedPrivateKey; authorPublicKey: string; now?: number;
}): Promise<T> {
  if (envelope.v !== 1 || envelope.protocol !== PROTOCOL) throw new Error('Unsupported encryption protocol');
  validateContext(expectedContext, now);
  if (canonicalJson(envelope.context) !== canonicalJson(expectedContext)) throw new Error('Content context mismatch');
  if (!Array.isArray(envelope.recipients) || envelope.recipients.length === 0 || envelope.recipients.length > MAX_RECIPIENT_DEVICES) throw new Error('Invalid recipient list');
  if (typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > MAX_CIPHERTEXT_CHARACTERS) throw new Error('Invalid ciphertext size');
  const author = await pgp.readKey({ armoredKey: authorPublicKey, config: CONFIG });
  const signedBy = envelope.recipients.find(r => r.deviceId === expectedContext.authorDeviceId && r.memberId === expectedContext.authorId);
  if (!signedBy || signedBy.fingerprint !== author.getFingerprint()) throw new Error('Author key does not match the envelope');
  if (!envelope.recipients.some(r => r.fingerprint === privateKey.getFingerprint())) throw new Error('This device is not a recipient');
  const message = await pgp.readMessage({ armoredMessage: envelope.ciphertext, config: CONFIG });
  const authenticatedPacket = [...message.packets].find(p => p instanceof pgp.SymEncryptedIntegrityProtectedDataPacket);
  if (!authenticatedPacket || (authenticatedPacket as unknown as { version: number }).version !== 2) throw new Error('RFC9580 authenticated encryption is required');
  const result = await pgp.decrypt({ message, decryptionKeys: privateKey, verificationKeys: author, expectSigned: true, format: 'utf8', config: CONFIG });
  if (result.signatures.length !== 1) throw new Error('Expected exactly one author signature');
  await result.signatures[0].verified;
  if (ENCODER.encode(result.data).byteLength > MAX_PLAINTEXT_BYTES) throw new Error('Decrypted content exceeds size limit');
  const decoded = JSON.parse(result.data) as { v: number; protocol: string; context: ContentContext; recipients: RecipientReference[]; payload: T };
  const { ciphertext: _, ...binding } = envelope;
  const { payload, ...signedBinding } = decoded;
  if (canonicalJson(signedBinding) !== canonicalJson(binding)) throw new Error('Signed content binding mismatch');
  return payload;
}

/** Standard OpenPGP detached signatures, suitable for device certificates and lifecycle changes. */
export async function signStatement<T>(statement: T, signingKey: UnlockedPrivateKey): Promise<SignedStatement<T>> {
  const signature = await pgp.sign({ message: await pgp.createMessage({ text: canonicalJson(statement) }), signingKeys: signingKey, detached: true, format: 'armored', config: CONFIG });
  return { statement, signature };
}
export async function verifyStatement<T>(signed: SignedStatement<T>, publicKey: string): Promise<T> {
  const result = await pgp.verify({ message: await pgp.createMessage({ text: canonicalJson(signed.statement) }), signature: await pgp.readSignature({ armoredSignature: signed.signature, config: CONFIG }), verificationKeys: await pgp.readKey({ armoredKey: publicKey, config: CONFIG }), expectSigned: true, config: CONFIG });
  if (result.signatures.length !== 1) throw new Error('Expected exactly one signature');
  await result.signatures[0].verified;
  return signed.statement;
}
export async function authorizeDevice(statement: DeviceAuthorization, trustedKey: UnlockedPrivateKey): Promise<SignedStatement<DeviceAuthorization>> {
  validateDeviceAuthorization(statement);
  return signStatement(statement, trustedKey);
}
function validateDeviceAuthorization(s: DeviceAuthorization, now = Date.now()): void {
  if (s.v !== 1 || s.purpose !== 'porchday-device-authorization') throw new Error('Invalid device authorization');
  checkId(s.memberId, 'member'); checkId(s.authorizingDeviceId, 'authorizing device'); checkId(s.deviceId, 'new device');
  if (!/^[0-9a-f]{64}$/.test(s.fingerprint) || s.challenge.length < 32 || s.challenge.length > 256) throw new Error('Invalid device fingerprint or challenge');
  const expires = checkDate(s.expiresAt, 'authorization expiry');
  if (expires <= now || expires > now + 15 * 60_000) throw new Error('Device authorization is not valid now');
}
export async function verifyDeviceAuthorization(signed: SignedStatement<DeviceAuthorization>, trustedPublicKey: string, expected: Pick<DeviceAuthorization, 'memberId' | 'deviceId' | 'fingerprint' | 'challenge'>, now = Date.now()): Promise<DeviceAuthorization> {
  const s = await verifyStatement(signed, trustedPublicKey);
  validateDeviceAuthorization(s, now);
  for (const k of ['memberId', 'deviceId', 'fingerprint', 'challenge'] as const) if (s[k] !== expected[k]) throw new Error('Device authorization binding mismatch');
  return s;
}

/** A secret HMAC tag leaks repeated use for this member/target only, never the emoji value. */
export async function reactionTag({ secret, targetId, memberId, emoji }: { secret: string; targetId: string; memberId: string; emoji: string }): Promise<string> {
  checkSecret(secret); checkId(targetId, 'reaction target'); checkId(memberId, 'reaction member');
  if (!/^(?:[a-z0-9_-]{1,40}|[uc]1_[a-f0-9]{64})$/.test(emoji)) throw new Error('Use a canonical reaction ID');
  const key = await crypto.subtle.importKey('raw', base64ToBytes(secret.replace(/-/g, '+').replace(/_/g, '/') + '='), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = ENCODER.encode(canonicalJson({ purpose: 'porchday-reaction-v1', targetId, memberId, emoji }));
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, data))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Portable password-encrypted export; keep the generated secret separate from the download. */
export async function encryptArchive(bytes: Uint8Array, secret = randomSecret()): Promise<{ ciphertext: Uint8Array; secret: string }> {
  checkSecret(secret);
  if (bytes.byteLength > MAX_PLAINTEXT_BYTES) throw new Error('Archive exceeds size limit; export in parts');
  const ciphertext = await pgp.encrypt({ message: await pgp.createMessage({ binary: bytes }), passwords: [secret], format: 'binary', config: CONFIG });
  return { ciphertext, secret };
}
export async function decryptArchive(ciphertext: Uint8Array, secret: string): Promise<Uint8Array> {
  checkSecret(secret);
  if (ciphertext.byteLength > MAX_CIPHERTEXT_CHARACTERS) throw new Error('Archive exceeds size limit');
  const { data } = await pgp.decrypt({ message: await pgp.readMessage({ binaryMessage: ciphertext, config: CONFIG }), passwords: [secret], format: 'binary', config: CONFIG });
  if (data.byteLength > MAX_PLAINTEXT_BYTES) throw new Error('Archive exceeds size limit');
  return data;
}
export function bytesToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(binary);
}
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  // Copy directly: Uint8Array.from(string, callback) allocates/iterates through
  // every character before constructing the byte array, costly for photos.
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export function utf8Encode(value: string): Uint8Array { return ENCODER.encode(value); }
export function utf8Decode(value: Uint8Array): string { return DECODER.decode(value); }
