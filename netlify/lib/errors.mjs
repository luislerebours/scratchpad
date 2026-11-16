import { randomBytes } from 'node:crypto';
import { adminStore, listPrefix } from './admin.mjs';

// Server errors for the admin dashboard: which function, the method, path and
// action, the status, and the error message. Never request or response bodies,
// cookies or query values, so no account content or secrets end up here.

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const KEEP_COUNT = 500;

const errorKey = at => `errors/${String(9e15 - at).padStart(16, '0')}-${randomBytes(3).toString('hex')}`;

export async function recordError(fn, req, status, message) {
  try {
    const url = new URL(req.url);
    const at = Date.now();
    await adminStore().setJSON(errorKey(at), {
      at,
      fn,
      method: req.method,
      path: url.pathname,
      action: url.searchParams.get('action') || null,
      status,
      message: String(message || '').slice(0, 300)
    });
  } catch (err) {
    console.error('Recording an error failed:', err.message);
  }
}

// Wraps a function's handler: a thrown error becomes a 500 (and is recorded),
// and any 5xx the handler returns is recorded too.
export function withErrors(fn, handler) {
  return async (req, context) => {
    try {
      const res = await handler(req, context);
      if (res?.status >= 500) await recordError(fn, req, res.status, `Returned ${res.status}`);
      return res;
    } catch (err) {
      console.error(`${fn}:`, err);
      await recordError(fn, req, 500, err?.message || String(err));
      return new Response(JSON.stringify({ error: 'Something went wrong. Try again.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      });
    }
  };
}

// Newest first. Old ones (over 30 days, or past the newest 500) are cleared as they're read.
export async function readErrors(limit = 200) {
  const store = adminStore();
  const { blobs } = await listPrefix(store, 'errors/');
  const keys = blobs.map(b => b.key).sort();
  const cutoff = String(9e15 - (Date.now() - KEEP_MS)).padStart(16, '0');
  const stale = keys.filter((key, i) => i >= KEEP_COUNT || key.slice(7, 23) > cutoff);
  await Promise.all(stale.map(key => store.delete(key)));
  const fresh = keys.filter(key => !stale.includes(key)).slice(0, limit);
  return (await Promise.all(fresh.map(key => store.get(key, { type: 'json' })))).filter(Boolean);
}

export async function clearErrors() {
  const store = adminStore();
  const { blobs } = await listPrefix(store, 'errors/');
  await Promise.all(blobs.map(({ key }) => store.delete(key)));
  return blobs.length;
}
