import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env, json, sameOrigin, sign, verify } from './auth.mjs';

// The admin dashboard's own sign-in, kept apart from ScrapSheet accounts:
// admins are individual records in their own store, sign in with a password
// and a TOTP code (or a one-time recovery code), and hold a short, strict
// cookie of their own. Being an admin gives no plan or app access, and an
// app account gives no admin access.

export const adminStore = () => getStore({ name: 'scratchpad-admin', consistency: 'strong' });

// Keys starting with a prefix. Lists everything and filters (as the old admin
// view did), which also works with the local Blobs server used in tests.
export async function listPrefix(store, prefix) {
  const { blobs } = await store.list();
  return { blobs: blobs.filter(({ key }) => key.startsWith(prefix)) };
}

const COOKIE = 'ss_admin';
export const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
export const adminId = email => createHash('sha256').update(`admin:${email}`).digest('hex').slice(0, 32);

// ---- TOTP (RFC 6238: SHA-1, 6 digits, 30 seconds) ----

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes) {
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
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32(randomBytes(20));

export function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

const currentStep = () => Math.floor(Date.now() / 30_000);

// The step the code matches (now, or one step either side for clock drift),
// or null. A step at or before lastStep was already used: no replays.
export function checkTotp(secret, code, lastStep = 0) {
  const given = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const now = currentStep();
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    const expected = totpAt(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return step;
  }
  return null;
}

export const otpauthUri = (secret, email) =>
  `otpauth://totp/${encodeURIComponent(`ScrapSheet Admin:${email}`)}?secret=${secret}&issuer=${encodeURIComponent('ScrapSheet Admin')}&algorithm=SHA1&digits=6&period=30`;

// ---- Recovery codes: ten, shown once, each works once ----

export const hashRecovery = code => createHash('sha256').update(`admin-recovery:${String(code).toLowerCase().replace(/[^a-z0-9]/g, '')}`).digest('hex');

export function newRecoveryCodes() {
  const codes = Array.from({ length: 10 }, () => {
    const raw = base32(randomBytes(8)).toLowerCase().slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashRecovery) };
}

// ---- Setup token (ADMIN_SETUP_TOKEN, set by the site owner in Netlify) ----

export function setupTokenOk(given) {
  const expected = env('ADMIN_SETUP_TOKEN') || '';
  if (expected.length < 24) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(String(given || '')).digest();
  return timingSafeEqual(a, b);
}

export const setupConfigured = () => (env('ADMIN_SETUP_TOKEN') || '').length >= 24;

// ---- Sessions ----

export async function adminCookie(admin) {
  const now = Date.now();
  const token = await sign({ t: 'a', id: admin.id, v: admin.version, iat: now, exp: now + ADMIN_SESSION_MS });
  return `${COOKIE}=${token}; Path=/; Max-Age=${ADMIN_SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
}

export const clearedAdminCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

function readCookie(req) {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

// The signed-in admin, or an error response. Checked on every admin request:
// same origin, a valid admin cookie, an active admin, and the session not revoked.
export async function requireAdmin(req) {
  if (!sameOrigin(req)) return { error: json({ error: 'Bad origin' }, 403) };
  const session = await verify(readCookie(req));
  if (!session || session.t !== 'a') return { error: json({ error: 'Admin sign-in required' }, 401) };
  const admin = await adminStore().get(`admins/${session.id}`, { type: 'json' });
  if (!admin || admin.disabledAt || !admin.totp?.confirmedAt || admin.version !== session.v) {
    return { error: json({ error: 'Admin sign-in required' }, 401, { 'Set-Cookie': clearedAdminCookie() }) };
  }
  return { admin };
}

// ---- Audit log: newest first (keys sort by time, reversed) ----

const auditKey = () => `audit/${String(9e15 - Date.now()).padStart(16, '0')}-${randomBytes(3).toString('hex')}`;

export async function audit(req, admin, action, details = {}) {
  const ip = req?.headers?.get('x-nf-client-connection-ip') || null;
  await adminStore().setJSON(auditKey(), {
    at: Date.now(),
    admin: admin ? { id: admin.id, email: admin.email } : null,
    action,
    ...details,
    ip
  });
}

export async function readAudit(limit = 200) {
  const store = adminStore();
  const { blobs } = await listPrefix(store, 'audit/');
  const keys = blobs.map(b => b.key).sort().slice(0, limit);
  return (await Promise.all(keys.map(key => store.get(key, { type: 'json' })))).filter(Boolean);
}

// ---- App settings the dashboard can change ----

const DEFAULT_SETTINGS = { signupsOpen: true };

export async function readSettings() {
  const saved = await adminStore().get('settings', { type: 'json' }).catch(() => null);
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

export async function writeSettings(settings) {
  await adminStore().setJSON('settings', settings);
}
