// End-to-end encryption for ScrapSheet, using only the browser's Web Crypto.
//
// Keys:
//   password ──PBKDF2──► auth secret (sent to the server, which stores only a hash of it)
//                    └─► key-encryption key (never leaves the device)
//   master key   random, wrapped by the key-encryption key and by the recovery key
//   sheet keys   random per sheet, wrapped by the master key; lock the sheet's text, name and images
//   file keys    random per file, wrapped by its sheet's key; lock the file, its name and thumbnail
//
// Encrypted text is "e1:" + base64url(iv ‖ ciphertext); encrypted bytes are iv ‖ ciphertext.
// AES-256-GCM throughout, a fresh 12-byte IV every time.

const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const KDF_ITERATIONS = 600_000;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const OVERHEAD = IV_BYTES + TAG_BYTES; // added to every encrypted chunk
const PREFIX = 'e1:';
const AES = { name: 'AES-GCM', length: 256 };

// ---- base64url ----

export function toB64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < view.length; i += 0x8000) s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const random = n => crypto.getRandomValues(new Uint8Array(n));

// ---- Password: one PBKDF2 run gives the sign-in secret and the key that unlocks the master key ----

export async function passwordKeys(email, password) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = enc.encode(`scratchpad-e2ee-v1:${String(email).trim().toLowerCase()}`);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: KDF_ITERATIONS }, base, 512));
  const auth = toB64(bits.slice(0, 32));
  const kek = await subtle.importKey('raw', bits.slice(32), AES, false, ['wrapKey', 'unwrapKey']);
  return { auth, kek };
}

// ---- A share link's password ----
// One PBKDF2 run gives a proof (sent to the server, which keeps only a one-way
// hash of it and asks for it before serving the link) and a key that locks the
// item's key inside the link. The password itself never leaves the device.
export const newLinkSalt = () => toB64(random(16));

export async function linkPasswordKeys(password, salt) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations: KDF_ITERATIONS }, base, 512));
  return { proof: toB64(bits.slice(0, 32)), kek: await subtle.importKey('raw', bits.slice(32), AES, false, ['wrapKey', 'unwrapKey']) };
}

// ---- Recovery key: 20 random bytes as 32 letters and digits, in groups of four ----

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1 to misread

export function newRecoveryKey() {
  const bytes = random(20);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g).join('-');
}

export function normalizeRecoveryKey(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length === 32 && [...clean].every(c => B32.includes(c)) ? clean : null;
}

async function recoveryKek(recoveryKey, salt) {
  const clean = normalizeRecoveryKey(recoveryKey);
  if (!clean) throw new Error('That recovery key isn’t complete. It has 32 letters and numbers.');
  const base = await subtle.importKey('raw', enc.encode(clean), 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('scratchpad recovery v1') }, base, AES, false, ['wrapKey', 'unwrapKey']);
}

// ---- Keys wrapped by other keys ----

export const newKey = () => subtle.generateKey(AES, true, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);

export async function wrap(key, wrappingKey) {
  const iv = random(IV_BYTES);
  const wrapped = new Uint8Array(await subtle.wrapKey('raw', key, wrappingKey, { name: 'AES-GCM', iv }));
  return toB64(concat(iv, wrapped));
}

export async function unwrap(text, wrappingKey, extractable = true) {
  const bytes = fromB64(text);
  return subtle.unwrapKey('raw', bytes.slice(IV_BYTES), wrappingKey, { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) }, AES, extractable, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}

// A new master key and its keyring: wrapped by the password and by a new recovery key.
export async function newKeyring(kek) {
  const master = await newKey();
  const recoveryKey = newRecoveryKey();
  const recoverySalt = random(16);
  const keyring = {
    v: 1,
    byPassword: await wrap(master, kek),
    byRecovery: await wrap(master, await recoveryKek(recoveryKey, recoverySalt)),
    recoverySalt: toB64(recoverySalt)
  };
  return { master, recoveryKey, keyring };
}

// The master key from the keyring, with the password's key (fails if the password is wrong).
export async function openWithPassword(keyring, kek) {
  try {
    return await unwrap(keyring.byPassword, kek, true);
  } catch {
    throw new Error('That password doesn’t unlock this account.');
  }
}

export async function openWithRecovery(keyring, recoveryKey) {
  const kek = await recoveryKek(recoveryKey, fromB64(keyring.recoverySalt));
  try {
    return await unwrap(keyring.byRecovery, kek, true);
  } catch {
    throw new Error('That recovery key doesn’t match this account.');
  }
}

// After a password change or reset: the same master key, wrapped for the new password.
export async function rewrapForPassword(keyring, master, kek) {
  return { ...keyring, byPassword: await wrap(master, kek) };
}

export async function rewrapForRecovery(keyring, master) {
  const recoveryKey = newRecoveryKey();
  const recoverySalt = random(16);
  return {
    recoveryKey,
    keyring: { ...keyring, byRecovery: await wrap(master, await recoveryKek(recoveryKey, recoverySalt)), recoverySalt: toB64(recoverySalt) }
  };
}

// ---- Content ----

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function encryptBytes(key, data) {
  const iv = random(IV_BYTES);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return concat(iv, sealed);
}

export async function decryptBytes(key, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) }, key, bytes.slice(IV_BYTES)));
}

export const isSealed = value => typeof value === 'string' && value.startsWith(PREFIX);

export async function encryptText(key, text) {
  return PREFIX + toB64(await encryptBytes(key, enc.encode(String(text))));
}

// Plain text (from before encryption, or a default like "Sheet 2") comes back as it is.
export async function decryptText(key, value) {
  if (!isSealed(value)) return value ?? '';
  return dec.decode(await decryptBytes(key, fromB64(value.slice(PREFIX.length))));
}

export const exportKey = async key => toB64(await subtle.exportKey('raw', key));
export const importKey = (text, extractable = true) => subtle.importKey('raw', fromB64(text), AES, extractable, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);

// ---- This device remembers the master key (unextractable) until sign-out ----

const DB = 'scratchpad-keys';
const STORE = 'keys';

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, run) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
  });
}

// Kept unextractable: even code running on this page can't read the key itself out.
export async function rememberMaster(account, master) {
  const iv = random(IV_BYTES);
  const through = await bootstrapKey();
  const keep = await subtle.unwrapKey('raw', await subtle.wrapKey('raw', master, through, { name: 'AES-GCM', iv }),
    through, { name: 'AES-GCM', iv }, AES, false, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
  await tx('readwrite', s => s.put(keep, account));
}

export async function recallMaster(account) {
  try {
    return (await tx('readonly', s => s.get(account))) || null;
  } catch {
    return null;
  }
}

// An encrypted copy of what the app last showed (see "Instant open" in app.js),
// kept beside the key and cleared with it.
export async function keepSnapshot(sealed) {
  try {
    await tx('readwrite', s => s.put(sealed, 'snapshot'));
  } catch {
    // Not kept: the app just opens the slower way next time.
  }
}

export async function recallSnapshot() {
  try {
    return (await tx('readonly', s => s.get('snapshot'))) || null;
  } catch {
    return null;
  }
}

export async function forgetKeys() {
  try {
    await tx('readwrite', s => s.clear());
  } catch {
    // Nothing kept.
  }
}

// A throwaway key only used to turn an extractable master key into an unextractable copy.
let bootstrap = null;
function bootstrapKey() {
  bootstrap ??= subtle.generateKey(AES, false, ['wrapKey', 'unwrapKey']);
  return bootstrap;
}
