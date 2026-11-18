import { getStore } from '@netlify/blobs';

// The cheap safety-net check, as an edge function: Netlify bills edge
// functions per request only, with no compute time. Returns the change
// markers for the account's tabs and one sheet, like state?meta=poll.

const MAX_SHEETS = 10;
const enc = new TextEncoder();

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

const fromBase64url = text => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c => c.charCodeAt(0));
};

const authStore = () => getStore({ name: 'scratchpad-auth', consistency: 'strong' });

// The same secret and signature as the session cookie made in lib/auth.mjs.
let keyPromise = null;
function sessionKey() {
  keyPromise ??= (async () => {
    const secret = await authStore().get('secret');
    if (!secret) throw new Error('No signing secret');
    return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  })().catch(err => {
    keyPromise = null;
    throw err;
  });
  return keyPromise;
}

async function readSession(req) {
  const cookie = (req.headers.get('cookie') || '').split(';').map(c => c.trim()).find(c => c.startsWith('sp_session='));
  const [body, sig] = (cookie?.slice('sp_session='.length) || '').split('.');
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify('HMAC', await sessionKey(), fromBase64url(sig), enc.encode(body));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
    return payload.t === 's' && payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export default async req => {
  const session = await readSession(req);
  if (!session) return json({ error: 'Sign in required' }, 401);
  const user = await authStore().get(`users/${session.ek}`, { type: 'json' });
  if (!user || user.version !== session.v || user.disabledAt || (session.sid && !(user.sessions || []).some(s => s.id === session.sid))) return json({ error: 'Sign in required' }, 401);

  const sheet = Number(new URL(req.url).searchParams.get('sheet'));
  if (!Number.isInteger(sheet) || sheet < 1 || sheet > MAX_SHEETS) return json({ error: 'Invalid sheet' }, 400);
  const state = getStore({ name: user.ns ? `u-${user.ns}` : 'scratchpad', consistency: 'strong' });
  const [sheets, text, files] = await Promise.all(
    ['sheets', `text-${sheet}`, `files-${sheet}`].map(part => state.get(`rev/${part}`))
  );
  return json({ sheets: sheets || '0', text: text || '0', files: files || '0' });
};

export const config = { path: '/api/check' };
