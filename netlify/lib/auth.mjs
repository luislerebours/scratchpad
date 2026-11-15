import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Shared by the functions: accounts, sessions and where each account's data lives.

export const MAX_SHEETS = 10;
const COOKIE = 'sp_session';
const SESSION_MS = 365 * 24 * 60 * 60 * 1000;
const scryptAsync = promisify(scrypt);

export const env = key => globalThis.Netlify?.env?.get(key) ?? process.env[key];

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });

export const authStore = () => getStore({ name: 'scratchpad-auth', consistency: 'strong' });

export const parseSheet = value => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SHEETS ? n : null;
};

// Each account's data lives in its own stores. The original single-user data
// (stores named "scratchpad…") belongs to the account whose email matches
// OWNER_EMAIL, so it never has to be copied.
export function userStore(ns, kind, sheet = null) {
  const prefix = ns ? `u-${ns}` : 'scratchpad';
  const name = kind === 'state' ? prefix : `${prefix}-${kind}-${sheet}`;
  return getStore({ name, consistency: 'strong' });
}

// Change markers: every write sets one, so the page's 2-second check reads
// only these tiny values and fetches text, tabs or files when one changed.
// Separate keys per part avoid lost updates between devices.
export function bumpRev(ns, part) {
  const rev = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  return userStore(ns, 'state').set(`rev/${part}`, rev).then(() => rev);
}

export const normalizeEmail = email => String(email || '').trim().toLowerCase();

// The OWNER_EMAIL account is the admin.
export function isAdmin(user) {
  const owner = normalizeEmail(env('OWNER_EMAIL'));
  return Boolean(owner) && user?.email === owner;
}
export const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
export const emailKey = email => createHash('sha256').update(email).digest('hex').slice(0, 32);

// ---- Signed tokens (session cookie, password-setting step) ----

let secretPromise = null;
function secret() {
  // Made once per site and kept in Blobs, so there is no key to configure.
  secretPromise ??= (async () => {
    const store = authStore();
    let value = await store.get('secret');
    if (!value) {
      await store.set('secret', randomBytes(32).toString('hex'), { onlyIfNew: true });
      value = await store.get('secret');
    }
    if (!value) throw new Error('No signing secret');
    return value;
  })().catch(err => {
    secretPromise = null;
    throw err;
  });
  return secretPromise;
}

export async function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', await secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export async function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', await secret()).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp && payload.exp < Date.now() ? null : payload;
  } catch {
    return null;
  }
}

// ---- Passwords ----

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return { hash, salt };
}

export async function checkPassword(password, user) {
  const { hash } = await hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash || '', 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Codes: an animal and four digits, e.g. otter4821 ----

const ANIMALS = [
  'otter', 'panda', 'tiger', 'koala', 'zebra', 'llama', 'moose', 'bison', 'camel', 'eagle',
  'falcon', 'gecko', 'heron', 'hippo', 'horse', 'hyena', 'lemur', 'lion', 'lynx', 'mole',
  'newt', 'okapi', 'orca', 'owl', 'parrot', 'puffin', 'quail', 'rabbit', 'raven', 'rhino',
  'robin', 'seal', 'shark', 'sloth', 'snail', 'squid', 'stork', 'swan', 'tapir', 'toucan',
  'trout', 'turtle', 'walrus', 'whale', 'wolf', 'yak', 'badger', 'beaver', 'bobcat', 'cobra',
  'crane', 'dingo', 'dolphin', 'donkey', 'ferret', 'gorilla', 'iguana', 'jaguar', 'kiwi', 'lobster'
];

export const makeCode = () => `${ANIMALS[randomInt(ANIMALS.length)]}${String(randomInt(10000)).padStart(4, '0')}`;
export const normalizeCode = code => String(code || '').toLowerCase().replace(/\s+/g, '');
export const hashCode = (code, key) => createHash('sha256').update(`${key}:${code}`).digest('hex');

// ---- Rate limits (approximate; fine at this scale) ----

export async function allow(key, limit, windowMs) {
  const store = authStore();
  const now = Date.now();
  const recent = ((await store.get(`rate/${key}`, { type: 'json' })) || []).filter(t => now - t < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  await store.setJSON(`rate/${key}`, recent);
  return true;
}

// ---- Sessions ----

export async function sessionCookie(user) {
  const now = Date.now();
  const token = await sign({ t: 's', ek: emailKey(user.email), v: user.version, iat: now, exp: now + SESSION_MS });
  return `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearedCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

function readCookie(req) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

// Changes from other sites are refused: the cookie is SameSite=Lax, and this
// checks the Origin header as well for anything that writes.
export function sameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.get('origin');
  return !origin || origin === new URL(req.url).origin;
}

// The signed-in account, or a 401/403 response to return as-is.
export async function requireUser(req) {
  if (!sameOrigin(req)) return { error: json({ error: 'Bad origin' }, 403) };
  const session = await verify(readCookie(req));
  if (!session || session.t !== 's') return { error: json({ error: 'Sign in required' }, 401) };
  const user = await authStore().get(`users/${session.ek}`, { type: 'json' });
  if (!user || user.version !== session.v) {
    return { error: json({ error: 'Sign in required' }, 401, { 'Set-Cookie': clearedCookie() }) };
  }
  return { user, ns: user.ns };
}
