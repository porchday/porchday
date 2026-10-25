/** Optional remembered-device storage. It protects bytes at rest, not against same-origin JS. */
import * as pgp from 'openpgp';
import { canonicalJson, type UnlockedPrivateKey } from './index.ts';

const DB_NAME = 'porchday-device-v1';
const STORE_NAME = 'devices';
export interface RememberedDevice { memberId: string; deviceId: string; fingerprint: string }
interface StoredDevice extends RememberedDevice { wrappingKey: CryptoKey; iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer }

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onerror = () => reject(new Error('Device storage unavailable; use your recovery secret'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = operation(tx.objectStore(STORE_NAME));
      request.onerror = () => reject(new Error('Device storage operation failed'));
      tx.onabort = () => reject(new Error('Device storage operation failed'));
      tx.oncomplete = () => resolve(request.result);
    });
  } finally { db.close(); }
}
function storageId(meta: RememberedDevice): string { return `${meta.memberId}/${meta.deviceId}`; }
function aad(meta: RememberedDevice): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalJson({ purpose: 'porchday-remembered-device-v1', memberId: meta.memberId, deviceId: meta.deviceId, fingerprint: meta.fingerprint }));
}

/** Call only after an explicit 'Remember this private device' choice. */
export async function rememberDevice(meta: RememberedDevice, privateKey: UnlockedPrivateKey): Promise<void> {
  if (privateKey.getFingerprint() !== meta.fingerprint || !privateKey.isDecrypted()) throw new Error('Unlocked device fingerprint mismatch');
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(privateKey.armor());
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(meta), tagLength: 128 }, wrappingKey, bytes);
    await withStore('readwrite', store => store.put({ ...meta, wrappingKey, iv, ciphertext } satisfies StoredDevice, storageId(meta)));
  } finally { bytes.fill(0); }
}
export async function recallDevice(meta: RememberedDevice): Promise<UnlockedPrivateKey | null> {
  const stored = await withStore<StoredDevice | undefined>('readonly', store => store.get(storageId(meta)));
  if (!stored) return null;
  if (stored.fingerprint !== meta.fingerprint || stored.memberId !== meta.memberId || stored.deviceId !== meta.deviceId || stored.wrappingKey.extractable) throw new Error('Remembered device does not match trusted device');
  const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv, additionalData: aad(meta), tagLength: 128 }, stored.wrappingKey, stored.ciphertext));
  try {
    const key = await pgp.readPrivateKey({ armoredKey: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decrypted) });
    if (key.getFingerprint() !== meta.fingerprint || !key.isDecrypted()) throw new Error('Remembered key does not match trusted device');
    return key;
  } finally { decrypted.fill(0); }
}
/** Required on sign-out/shared-device cleanup and local revocation. */
export async function forgetDevice(meta: RememberedDevice): Promise<void> { await withStore('readwrite', store => store.delete(storageId(meta))); }
export async function forgetAllDevices(): Promise<void> { await withStore('readwrite', store => store.clear()); }
