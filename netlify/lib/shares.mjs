import { getStore } from '@netlify/blobs';
import { userStore } from './auth.mjs';

// Share links, shared by share.mjs and state.mjs. Each link lives in one
// store for all accounts (looked up by its token); each account keeps the
// list of its own tokens.

export const sharesStore = () => getStore({ name: 'scratchpad-shares', consistency: 'strong' });

export const ended = share => share.revoked ? 'off' : Date.now() > share.expiresAt ? 'expired' : null;

export async function readShareIndex(ns) {
  const data = await userStore(ns, 'state').get('meta/shares', { type: 'json' });
  return Array.isArray(data?.tokens) ? data.tokens : [];
}

export async function writeShareIndex(ns, tokens) {
  await userStore(ns, 'state').setJSON('meta/shares', { tokens, updatedAt: Date.now() });
}

export async function readShares(ns) {
  const store = sharesStore();
  const tokens = await readShareIndex(ns);
  return (await Promise.all(tokens.map(t => store.get(`shares/${t}`, { type: 'json' })))).filter(Boolean);
}

// The links still working, as the app needs them to mark shared files.
export async function liveShares(ns) {
  return (await readShares(ns))
    .filter(s => !ended(s))
    .map(s => ({ token: s.token, kind: s.kind, sheet: s.sheet, file: s.file || null, expiresAt: s.expiresAt }));
}
