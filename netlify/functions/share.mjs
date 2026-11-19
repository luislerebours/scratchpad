import { randomBytes } from 'node:crypto';
import { allow, checkPassword, hashPassword, json, parseSheet, requireUser, sameOrigin, sign, userStore, verify } from '../lib/auth.mjs';
import { isSealed } from '../lib/sheets.mjs';
import { fileStores, publicRecord } from '../lib/files.mjs';
import { ended, readShareIndex as readIndex, readShares, sharesStore, writeShareIndex as writeIndex } from '../lib/shares.mjs';
import { readSheets } from '../lib/sheets.mjs';
import { limitsFor, needsPro } from '../lib/plans.mjs';
import { withErrors } from '../lib/errors.mjs';
import { onR2, pieceBytes, pieceUrl } from '../lib/r2.mjs';

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
// A link's optional password (see linkPasswordKeys in crypto.js): we keep the
// salt the viewer needs, and a one-way hash of the proof it sends. A pass from
// an unlock lasts 12 hours, and only for the password it was given for.
const PASS_MS = 12 * 60 * 60 * 1000;
const b64ish = (v, max = 200) => typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
async function passwordFor(given) {
  if (!given) return null;
  if (!b64ish(given.salt, 40) || !b64ish(given.proof, 60)) return undefined;
  return { kdfSalt: given.salt, ...(await hashPassword(given.proof)) };
}
const KEEP_ENDED_MS = 30 * DAY; // ended links stay in the owner's list this long
// Per link: about 2.4 GB of downloads an hour, counted by piece size (pieces
// are 4 MB on Netlify, 1 MB in R2).
const BYTES_PER_HOUR = 2_400_000_000;

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
  protected: Boolean(share.pw),
  // The link's key part, locked with the sheet's key (only the owner's devices
  // can read it): for a link with a password, the owner can't rebuild it.
  linkFragment: share.linkFragment || null,
  state: ended(share) || 'on',
  // Why a link ended: you, replaced (a newer link for the same item), admin
  // (account deactivated), encryption (turned on for an older account),
  // expired, or null for links turned off before reasons were kept.
  reason: ended(share) === 'expired' ? 'expired' : share.revoked ? (share.revokedReason || (share.revokedBy === 'admin' ? 'admin' : null)) : null,
  endedAt: share.revoked ? share.revokedAt || null : ended(share) === 'expired' ? share.expiresAt : null
});

const REVOKE_REASONS = new Set(['you', 'encryption']);

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
async function underLimit(token, pieceBytes) {
  const store = sharesStore();
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `count/${token}/${hour}`;
  const used = Number(await store.get(key)) || 0;
  if (used >= BYTES_PER_HOUR) return false;
  await store.set(key, String(used + pieceBytes));
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
    if (!limitsFor(auth.user).share) return needsPro('Share links are part of Pro.');
    if (!DAY_CHOICES.has(days)) return json({ error: 'Choose 1, 7 or 30 days.' }, 400);
    const kind = body.kind === 'sheet' ? 'sheet' : 'file';
    const sheet = parseSheet(body.sheet);
    const file = kind === 'file' ? String(body.file || '') : null;
    if (!sheet || (kind === 'file' && !validId(file))) return json({ error: 'Nothing to share' }, 400);
    const found = await target({ ns, kind, sheet, file });
    if (!found) return json({ error: 'That is no longer here to share.' }, 404);

    // The page may pick the link's token itself, so a phone can open its share
    // menu with the link in the same tap (iOS refuses once anything has waited)
    // while this saves it. The page retries until it gets an answer, so the
    // same request can arrive twice: the link it already made is the answer.
    const wanted = body.token;
    if (wanted !== undefined && !(typeof wanted === 'string' && /^[A-Za-z0-9_-]{24}$/.test(wanted))) return json({ error: 'Update ScrapSheet (reload the page) and try again.' }, 400);
    if (wanted) {
      const taken = await store.get(`shares/${wanted}`, { type: 'json' });
      if (taken) {
        const same = taken.ns === ns && taken.kind === kind && taken.sheet === sheet && (taken.file || null) === file && !taken.revoked;
        return same ? json({ share: ownerView(taken), origin: url.origin }) : json({ error: 'That link is already in use. Make a new one.' }, 409);
      }
    }

    // One link per file or sheet: a new one replaces the old.
    const tokens = await readIndex(ns);
    const existing = await readShares(ns);
    await Promise.all(existing
      .filter(s => s.token !== wanted && !ended(s) && s.kind === kind && s.sheet === sheet && (s.file || null) === file)
      .map(s => store.setJSON(`shares/${s.token}`, { ...s, revoked: true, revokedAt: Date.now(), revokedReason: 'replaced' })));

    const pw = await passwordFor(body.password);
    if (pw === undefined || (pw && !isSealed(body.linkFragment))) return json({ error: 'Update ScrapSheet (reload the page) and try again.' }, 400);
    const now = Date.now();
    const share = {
      ...(pw ? { pw, linkFragment: body.linkFragment } : {}),
      token: wanted || randomBytes(18).toString('base64url'),
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
    await writeIndex(ns, [...new Set([...tokens, share.token])]);
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

  // Add, change or remove the link's password. The link's key part changes with it.
  if (body.action === 'password') {
    if (share.revoked) return json({ error: 'This link is turned off. Make a new one.' }, 409);
    const pw = await passwordFor(body.password);
    if (pw === undefined || (pw && !isSealed(body.linkFragment))) return json({ error: 'Update ScrapSheet (reload the page) and try again.' }, 400);
    const { pw: _, linkFragment: __, ...rest } = share;
    const next = pw ? { ...rest, pw, linkFragment: body.linkFragment } : rest;
    await store.setJSON(`shares/${token}`, next);
    return json({ share: ownerView(next), origin: url.origin });
  }

  if (body.action === 'revoke') {
    const next = { ...share, revoked: true, revokedAt: Date.now(), revokedReason: REVOKE_REASONS.has(body.reason) ? body.reason : 'you' };
    await store.setJSON(`shares/${token}`, next);
    return json({ share: ownerView(next), origin: url.origin });
  }

  return json({ error: 'Unknown action' }, 400);
}

async function visitor(req, url, token) {
  if (req.method !== 'GET' && !(req.method === 'POST' && url.searchParams.get('action') === 'unlock')) return publicJson({ error: 'Method not allowed' }, 405);
  if (!validToken(token)) return publicJson({ error: 'This link doesn’t work.', reason: 'missing' }, 404);
  const store = sharesStore();
  const share = await store.get(`shares/${token}`, { type: 'json' });
  if (!share) return publicJson({ error: 'This link doesn’t work.', reason: 'missing' }, 404);
  const why = ended(share);
  if (why) return publicJson({ error: why === 'off' ? 'This link was turned off.' : 'This link has expired.', reason: why }, 410);
  const found = await target(share);
  if (!found) return publicJson({ error: 'What was shared here has been deleted.', reason: 'gone' }, 410);

  // A link with a password: the viewer proves it once and gets a pass, sent
  // with every request after (`p`). Wrong tries are limited per link and per IP.
  if (req.method === 'POST') {
    if (!sameOrigin(req)) return publicJson({ error: 'Bad origin' }, 403);
    if (!share.pw) return publicJson({ error: 'This link has no password.' }, 400);
    const ip = req.headers.get('x-nf-client-connection-ip') || 'unknown';
    if (!(await allow(`sharepw-${token}`, 20, 15 * 60 * 1000)) || !(await allow(`sharepw-ip-${ip}`, 30, 15 * 60 * 1000))) {
      return publicJson({ error: 'Too many tries. Wait 15 minutes and try again.' }, 429);
    }
    const body = await req.json().catch(() => ({}));
    if (!b64ish(body.proof, 60) || !(await checkPassword(body.proof, share.pw))) return publicJson({ error: 'That password isn’t right.' }, 400);
    const pass = await sign({ t: 'sp', tok: token, k: share.pw.kdfSalt, exp: Date.now() + PASS_MS });
    return publicJson({ pass });
  }
  if (share.pw) {
    const pass = await verify(url.searchParams.get('p') || '');
    if (!pass || pass.t !== 'sp' || pass.tok !== token || pass.k !== share.pw.kdfSalt) {
      return publicJson({ error: 'This link needs a password.', reason: 'password', salt: share.pw.kdfSalt, kind: share.kind }, 401);
    }
  }

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
    if (!(await underLimit(token, record.chunkSize || 4_000_000))) return publicJson({ error: 'This link is busy. Try again in an hour.' }, 429);
    // In R2: counted here, then downloaded from there.
    if (onR2(record)) {
      // On a network that blocks the relay, the viewer asks for it through here.
      if (url.searchParams.get('via') === 'netlify') return bytesResponse(await pieceBytes(share.ns, share.sheet, record, chunk), 'application/octet-stream');
      return new Response(null, { status: 302, headers: { Location: await pieceUrl(share.ns, share.sheet, record, chunk), 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
    }
    const data = await fileStores(share.ns, share.sheet).chunks.get(`${record.id}-${chunk}`, { type: 'arrayBuffer' });
    return data ? bytesResponse(data, 'application/octet-stream') : publicJson({ error: 'Not found' }, 404);
  }

  if (thumbId !== null) {
    const record = await fileOfShare(thumbId);
    const data = record?.thumb ? await fileStores(share.ns, share.sheet).thumbs.get(record.id, { type: 'arrayBuffer' }) : null;
    return data ? bytesResponse(data, record.enc ? 'application/octet-stream' : record.thumb.type) : publicJson({ error: 'Not found' }, 404);
  }

  if (imageId !== null) {
    if (share.kind !== 'sheet' || !validId(imageId)) return publicJson({ error: 'Not found' }, 404);
    const record = await userStore(share.ns, 'images', share.sheet).get(imageId, { type: 'json' });
    if (!record?.complete) return publicJson({ error: 'Not found' }, 404);
    // Locked images go out as they are stored; the viewer unlocks them with the key in its link.
    const send = (data, type) => record.enc
      ? new Response(data, { headers: { 'Content-Type': 'application/octet-stream', 'X-Image-Type': type, 'X-Sealed': '1', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' } })
      : bytesResponse(data, type);
    if (record.preview) {
      const data = await userStore(share.ns, 'image-previews', share.sheet).get(imageId, { type: 'arrayBuffer' });
      if (data) return send(data, record.preview.type);
    }
    const data = await userStore(share.ns, 'image-chunks', share.sheet).get(`${imageId}-0`, { type: 'arrayBuffer' });
    return data ? send(data, record.type) : publicJson({ error: 'Not found' }, 404);
  }

  // What's shared. Counted as a view.
  // Counted on the record as it is now, not as it was when this request began:
  // a password or expiry changed meanwhile must not be written over.
  const fresh = (await store.get(`shares/${token}`, { type: 'json' })) || share;
  await store.setJSON(`shares/${token}`, { ...fresh, views: (fresh.views || 0) + 1, viewedAt: Date.now() });
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

export default withErrors('share', async req => {
  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  return token === null ? owner(req, url) : visitor(req, url, token);
});
