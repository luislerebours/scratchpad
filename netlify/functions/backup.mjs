import { getStore, listStores } from '@netlify/blobs';
import { json } from '../lib/auth.mjs';
import { withErrors } from '../lib/errors.mjs';
import { verifyBackupToken } from '../lib/github-oidc.mjs';

// The nightly backup to Google Drive (.github/workflows/backup.yml,
// tools/backup/). Only that workflow, on main, can call this: it signs in with
// a token GitHub signs (lib/github-oidc.mjs), so no password is stored.
// Read-only: it lists every Blobs store and the etag of every key in it
// (op=index), and returns one blob's bytes (op=get). The workflow keeps a
// mirror and fetches only what changed since the night before.
// Account content is end-to-end encrypted, so what it reads is ciphertext;
// accounts, sign-in records and settings aren't, which is why the copy in
// Drive is locked with the backup passphrase.

const INDEX_BUDGET_MS = 6000; // stop adding stores to one answer after this

async function allStoreNames() {
  const names = [];
  for await (const page of listStores({ paginate: true })) names.push(...page.stores);
  return [...new Set(names)].sort();
}

async function storeKeys(name) {
  const store = getStore({ name, consistency: 'strong' });
  const blobs = [];
  for await (const page of store.list({ paginate: true })) {
    for (const b of page.blobs) blobs.push([b.key, b.etag]);
  }
  return blobs;
}

export default withErrors('backup', async req => {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer || !(await verifyBackupToken(bearer))) return json({ error: 'Not allowed' }, 401);
  const url = new URL(req.url);
  const op = url.searchParams.get('op');

  // Stores after `after` (by name), as many as fit in a few seconds; `next`
  // says where to carry on (null: that was the last).
  if (op === 'index') {
    const after = url.searchParams.get('after') || '';
    const started = Date.now();
    const names = (await allStoreNames()).filter(n => n > after);
    const stores = [];
    for (const name of names) {
      stores.push({ name, blobs: await storeKeys(name) });
      if (Date.now() - started > INDEX_BUDGET_MS) break;
    }
    const last = stores.at(-1)?.name;
    return json({ stores, next: last && last !== names.at(-1) ? last : null });
  }

  if (op === 'get') {
    const name = url.searchParams.get('store');
    const key = url.searchParams.get('key');
    if (!name || !key) return json({ error: 'store and key needed' }, 400);
    const r = await getStore({ name, consistency: 'strong' }).getWithMetadata(key, { type: 'arrayBuffer' });
    if (!r) return json({ error: 'Not found' }, 404);
    return new Response(r.data, {
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', ETag: r.etag || '' }
    });
  }

  return json({ error: 'Unknown op' }, 400);
});
