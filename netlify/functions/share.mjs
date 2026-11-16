import { randomBytes } from 'node:crypto';
import { json, parseSheet, requireUser, sameOrigin, userStore } from '../lib/auth.mjs';
import { fileStores, publicRecord } from '../lib/files.mjs';
import { ended, readShareIndex as readIndex, readShares, sharesStore, writeShareIndex as writeIndex } from '../lib/shares.mjs';
import { readSheets } from '../lib/sheets.mjs';

// Share links: anyone with the link can view and download a file, or a sheet
// with its text, images and files, until the link expires or is turned off.
//
// Owner (signed in):  GET ?mine=1, POST { action: create | extend | revoke }
// Anyone with a link: GET ?t=TOKEN               what is shared
//                     GET ?t=TOKEN&file=ID&chunk=N   one 4 MB piece of a file
//                     GET ?t=TOKEN&thumb=ID          a file's thumbnail
//                     GET ?t=TOKEN&image=ID          an image in a shared sheet's text

const DAY = 24 * 60 * 60 * 1000;
const DAY_CHOICES = new Set([1, 7, 30]);
const KEEP_ENDED_MS = 30 * DAY; // ended links stay in the owner's list this long
const CHUNKS_PER_HOUR = 600; // per link: about 2.4 GB of downloads an hour

const validToken = t => typeof t === 'string' && /^[A-Za-z0-9_-]{24,64}$/.test(t);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);

// Public responses: never indexed, never shared by caches.
const publicJson = (body, status = 200) => json(body, status, { 'X-Robots-Tag': 'noindex, nofollow' });
const bytesResponse = (data, type) => new Response(data, {
  headers: {
    'Content-Type': type,
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow'
  }
});

// What the owner sees for one of their links.
const ownerView = share => ({
  token: share.token,
  kind: share.kind,
  sheet: share.sheet,
  file: share.file || null,
  name: share.name,
  createdAt: share.createdAt,
  expiresAt: share.expiresAt,
  revoked: Boolean(share.revoked),
  views: share.views || 0,
  state: ended(share) || 'on'
});

// The live thing a link points at, or null once it's deleted.
async function target(share) {
  const state = userStore(share.ns, 'state');
  const { sheets } = await readSheets(state);
  const sheet = sheets.find(s => s.id === share.sheet);
  if (!sheet) return null;
  const files = fileStores(share.ns, share.sheet);
  if (share.kind === 'file') {
    const record = await files.records.get(share.file, { type: 'json' });
    return record?.complete && !record.deletedAt ? { sheet, record } : null;
  }
  return { sheet, state, files };
}

async function sheetFiles(files, sheet) {
  const { blobs } = await files.records.list();
  const all = await Promise.all(blobs.map(({ key }) => files.records.get(key, { type: 'json' }).catch(() => null)));
  return all.filter(r => r?.complete && !r.deletedAt).sort((a, b) => b.uploadedAt - a.uploadedAt).map(r => publicRecord(r, sheet));
}

// A coarse per-hour counter on downloads, so a leaked link can't run up unlimited traffic.
async function underLimit(token) {
  const store = sharesStore();
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `count/${token}/${hour}`;
  const used = Number(await store.get(key)) || 0;
  if (used >= CHUNKS_PER_HOUR) return false;
  await store.set(key, String(used + 1));
  // Starting a new hour: last hour's count is no longer needed.
  if (!used) await store.delete(`count/${token}/${hour - 1}`);
  return true;
}

async function owner(req, url) {
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { ns } = auth;
  const store = sharesStore();

  if (req.method === 'GET') {
    // Also forget links that ended over a month ago.
    const tokens = await readIndex(ns);
    const shares = await readShares(ns);
    const stale = shares.filter(s => ended(s) && Date.now() - Math.min(s.expiresAt, s.revokedAt || Infinity) > KEEP_ENDED_MS);
    if (stale.length || shares.length !== tokens.length) {
      await Promise.all(stale.map(s => store.delete(`shares/${s.token}`)));
      await writeIndex(ns, shares.filter(s => !stale.includes(s)).map(s => s.token));
    }
    const list = shares.filter(s => !stale.includes(s)).map(ownerView).sort((a, b) => b.createdAt - a.createdAt);
    return json({ shares: list, origin: url.origin });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!sameOrigin(req)) return json({ error: 'Bad origin' }, 403);
  const body = await req.json().catch(() => ({}));
  const days = Number(body.days);

  if (body.action === 'create') {
    if (!DAY_CHOICES.has(days)) return json({ error: 'Choose 1, 7 or 30 days.' }, 400);
    const kind = body.kind === 'sheet' ? 'sheet' : 'file';
    const sheet = parseSheet(body.sheet);
    const file = kind === 'file' ? String(body.file || '') : null;
    if (!sheet || (kind === 'file' && !validId(file))) return json({ error: 'Nothing to share' }, 400);
    const found = await target({ ns, kind, sheet, file });
    if (!found) return json({ error: 'That is no longer here to share.' }, 404);

    // One link per file or sheet: a new one replaces the old.
    const tokens = await readIndex(ns);
    const existing = await readShares(ns);
    await Promise.all(existing
      .filter(s => !ended(s) && s.kind === kind && s.sheet === sheet && (s.file || null) === file)
      .map(s => store.setJSON(`shares/${s.token}`, { ...s, revoked: true, revokedAt: Date.now() })));

    const now = Date.now();
    const share = {
      token: randomBytes(18).toString('base64url'),
      ns,
      kind,
      sheet,
      file,
      name: kind === 'file' ? found.record.name : found.sheet.name,
      createdAt: now,
      expiresAt: now + days * DAY,
      views: 0
    };
    await store.setJSON(`shares/${share.token}`, share);
    await writeIndex(ns, [...tokens, share.token]);
    return json({ share: ownerView(share), origin: url.origin });
  }

  const token = String(body.token || '');
  if (!validToken(token)) return json({ error: 'Unknown link' }, 400);
  const share = await store.get(`shares/${token}`, { type: 'json' });
  if (!share || share.ns !== ns) return json({ error: 'Unknown link' }, 404);

  if (body.action === 'extend') {
    if (!DAY_CHOICES.has(days)) return json({ error: 'Choose 1, 7 or 30 days.' }, 400);
    if (share.revoked) return json({ error: 'This link is turned off. Make a new one.' }, 409);
    const next = { ...share, expiresAt: Date.now() + days * DAY };
    await store.setJSON(`shares/${token}`, next);
    return json({ share: ownerView(next), origin: url.origin });
  }

  if (body.action === 'revoke') {
    const next = { ...share, revoked: true, revokedAt: Date.now() };
    await store.setJSON(`shares/${token}`, next);
    return json({ share: ownerView(next), origin: url.origin });
  }

  return json({ error: 'Unknown action' }, 400);
}

async function visitor(req, url, token) {
  if (req.method !== 'GET') return publicJson({ error: 'Method not allowed' }, 405);
  if (!validToken(token)) return publicJson({ error: 'This link doesn’t work.', reason: 'missing' }, 404);
  const store = sharesStore();
  const share = await store.get(`shares/${token}`, { type: 'json' });
  if (!share) return publicJson({ error: 'This link doesn’t work.', reason: 'missing' }, 404);
  const why = ended(share);
  if (why) return publicJson({ error: why === 'off' ? 'This link was turned off.' : 'This link has expired.', reason: why }, 410);
  const found = await target(share);
  if (!found) return publicJson({ error: 'What was shared here has been deleted.', reason: 'gone' }, 410);

  const fileId = url.searchParams.get('file');
  const thumbId = url.searchParams.get('thumb');
  const imageId = url.searchParams.get('image');

  // A file of this link: the shared file itself, or one on the shared sheet.
  const fileOfShare = async id => {
    if (!validId(id)) return null;
    if (share.kind === 'file') return id === share.file ? found.record : null;
    const record = await found.files.records.get(id, { type: 'json' });
    return record?.complete && !record.deletedAt ? record : null;
  };

  if (fileId !== null) {
    const record = await fileOfShare(fileId);
    const chunk = Number(url.searchParams.get('chunk'));
    if (!record || !Number.isInteger(chunk) || chunk < 0 || chunk >= record.chunks) return publicJson({ error: 'Not found' }, 404);
    if (!(await underLimit(token))) return publicJson({ error: 'This link is busy. Try again in an hour.' }, 429);
    const data = await fileStores(share.ns, share.sheet).chunks.get(`${record.id}-${chunk}`, { type: 'arrayBuffer' });
    return data ? bytesResponse(data, 'application/octet-stream') : publicJson({ error: 'Not found' }, 404);
  }

  if (thumbId !== null) {
    const record = await fileOfShare(thumbId);
    const data = record?.thumb ? await fileStores(share.ns, share.sheet).thumbs.get(record.id, { type: 'arrayBuffer' }) : null;
    return data ? bytesResponse(data, record.thumb.type) : publicJson({ error: 'Not found' }, 404);
  }

  if (imageId !== null) {
    if (share.kind !== 'sheet' || !validId(imageId)) return publicJson({ error: 'Not found' }, 404);
    const record = await userStore(share.ns, 'images', share.sheet).get(imageId, { type: 'json' });
    if (!record?.complete) return publicJson({ error: 'Not found' }, 404);
    if (record.preview) {
      const data = await userStore(share.ns, 'image-previews', share.sheet).get(imageId, { type: 'arrayBuffer' });
      if (data) return bytesResponse(data, record.preview.type);
    }
    const data = await userStore(share.ns, 'image-chunks', share.sheet).get(`${imageId}-0`, { type: 'arrayBuffer' });
    return data ? bytesResponse(data, record.type) : publicJson({ error: 'Not found' }, 404);
  }

  // What's shared. Counted as a view.
  await store.setJSON(`shares/${token}`, { ...share, views: (share.views || 0) + 1, viewedAt: Date.now() });
  if (share.kind === 'file') {
    const { sheet: _, ...file } = publicRecord(found.record, share.sheet);
    return publicJson({ kind: 'file', name: share.name, expiresAt: share.expiresAt, file });
  }
  const doc = await found.state.get(`sheets/${share.sheet}`, { type: 'json' });
  const files = (await sheetFiles(found.files, share.sheet)).map(({ sheet: _, ...f }) => f);
  return publicJson({
    kind: 'sheet',
    name: found.sheet.name,
    expiresAt: share.expiresAt,
    html: typeof doc?.html === 'string' ? doc.html : null,
    text: typeof doc?.html === 'string' ? null : String(doc?.text || ''),
    files
  });
}

export default async req => {
  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  return token === null ? owner(req, url) : visitor(req, url, token);
};
