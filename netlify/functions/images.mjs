import { randomUUID } from 'node:crypto';
import { MAX_SHEETS, json, parseSheet, requireUser, userStore } from '../lib/auth.mjs';
import { isSealed } from '../lib/sheets.mjs';
import { overQuota } from '../lib/usage.mjs';

// Images pasted into a sheet's text. Netlify functions take about 4.5 MB per
// request, so each image is kept twice: the untouched original in 4 MB chunks
// (up to 100 MB), and a small display copy the page makes before uploading,
// which is what the text shows. Small images skip the copy and show as-is.
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1000 * 1000;
const CHUNK_BYTES = 4 * 1000 * 1000;
const UNUSED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif']);
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const validId = id => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
const chunkKey = (id, index) => `${id}-${index}`;

const stores = (ns, sheet) => ({
  records: userStore(ns, 'images', sheet),
  chunks: userStore(ns, 'image-chunks', sheet),
  previews: userStore(ns, 'image-previews', sheet)
});

// An id always names the same bytes, so the browser may keep it for good;
// "private" keeps shared caches (Netlify's CDN) from serving it to anyone else.
const imageHeaders = (type, shownAs) => ({
  ...(shownAs ? { 'X-Image-Type': shownAs } : {}),
  'Content-Type': type,
  'Cache-Control': 'private, max-age=31536000, immutable',
  'X-Content-Type-Options': 'nosniff'
});

async function deleteImage(store, record) {
  await Promise.all([
    ...Array.from({ length: record.chunks }, (_, i) => store.chunks.delete(chunkKey(record.id, i))),
    store.previews.delete(record.id)
  ]);
  await store.records.delete(record.id);
}

// Deletes this sheet's images that no sheet's text has used for a week, and
// uploads abandoned midway. Every sheet is checked because text (and its
// images) can move between sheets.
async function removeUnusedImages(ns, sheet) {
  const state = userStore(ns, 'state');
  const docs = await Promise.all(
    Array.from({ length: MAX_SHEETS }, (_, i) => state.get(`sheets/${i + 1}`, { type: 'json' }))
  );
  const used = new Set();
  for (const doc of docs) {
    // Locked text lists its images; older text we read for them.
    if (Array.isArray(doc?.images)) doc.images.forEach(id => used.add(id));
    for (const match of String(doc?.html || '').matchAll(/[?&;]id=([A-Za-z0-9-]{1,64})/g)) used.add(match[1]);
  }

  const store = stores(ns, sheet);
  const { blobs } = await store.records.list();
  await Promise.all(blobs.map(async ({ key }) => {
    if (used.has(key)) return;
    const record = await store.records.get(key, { type: 'json' });
    if (!record) return;
    const age = Date.now() - Number(record.uploadedAt || record.startedAt || 0);
    if (age > (record.complete ? UNUSED_GRACE_MS : STALE_UPLOAD_MS)) await deleteImage(store, record);
  }));
}

export default async (req, context) => {
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  const { ns } = auth;
  const url = new URL(req.url);
  const sheet = parseSheet(url.searchParams.get('sheet'));
  if (!sheet) return json({ error: 'Invalid sheet' }, 400);
  const store = stores(ns, sheet);
  const id = url.searchParams.get('id');
  const action = url.searchParams.get('action');

  // Start an upload: reserve an id and tell the page how to chunk it.
  if (req.method === 'POST' && action === 'start') {
    const body = await req.json().catch(() => null);
    // A locked image's type is locked too (with its sheet's key).
    const sealed = Boolean(body?.enc);
    const type = sealed ? String(body?.type || '') : String(body?.type || '').toLowerCase();
    const size = Number(body?.size);
    if (sealed ? !isSealed(type) : !TYPES.has(type)) return json({ error: 'Unsupported image type' }, 415);
    if (!Number.isInteger(size) || size <= 0) return json({ error: 'Invalid size' }, 400);
    if (size > MAX_IMAGE_BYTES) return json({ error: 'Image is over 100 MB' }, 413);
    const full = await overQuota(auth.user, ns, size);
    if (full) return json({ error: full, quota: true }, 413);

    // An encrypted account only sends locked images (locked with the sheet's key).
    if (auth.user.keyring && !sealed) return json({ error: 'Reload Scratch Pad to keep adding images.' }, 400);
    const record = {
      ...(sealed ? { enc: 1 } : {}),
      id: randomUUID(),
      type,
      size,
      chunkSize: CHUNK_BYTES,
      chunks: Math.ceil(size / CHUNK_BYTES),
      preview: null,
      complete: false,
      startedAt: Date.now()
    };
    await store.records.setJSON(record.id, record);
    return json({ id: record.id, chunkSize: record.chunkSize, chunks: record.chunks });
  }

  if (!validId(id)) return json({ error: 'Invalid id' }, 400);
  const record = await store.records.get(id, { type: 'json' });
  if (!record) return json({ error: 'Not found' }, 404);

  const chunkParam = url.searchParams.get('chunk');
  const chunkIndex = chunkParam === null ? null : Number(chunkParam);
  if (chunkIndex !== null && !(Number.isInteger(chunkIndex) && chunkIndex >= 0 && chunkIndex < record.chunks)) {
    return json({ error: 'Invalid chunk' }, 400);
  }

  if (req.method === 'PUT' && !record.complete) {
    const data = await req.arrayBuffer();
    if (chunkIndex !== null) {
      const expected = Math.min(record.chunkSize, record.size - chunkIndex * record.chunkSize) + (record.enc ? 28 : 0);
      if (data.byteLength !== expected) return json({ error: 'Wrong chunk size' }, 400);
      await store.chunks.set(chunkKey(id, chunkIndex), data);
      return json({ ok: true });
    }
    if (url.searchParams.get('preview') === '1') {
      // A locked display copy arrives as plain bytes; the page says what it really is.
      const sent = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const type = record.enc ? String(url.searchParams.get('type') || '') : sent;
      if (record.enc ? !isSealed(type) : !PREVIEW_TYPES.has(type)) return json({ error: 'Unsupported preview type' }, 415);
      if (!data.byteLength || data.byteLength > MAX_PREVIEW_BYTES + 28) return json({ error: 'Preview too large' }, 413);
      await store.previews.set(id, data);
      await store.records.setJSON(id, { ...record, preview: { type, size: data.byteLength } });
      return json({ ok: true });
    }
  }

  if (req.method === 'POST' && action === 'finish') {
    if (record.complete) return json({ error: 'Already finished' }, 409);
    const present = await Promise.all(
      Array.from({ length: record.chunks }, (_, i) => store.chunks.getMetadata(chunkKey(id, i)))
    );
    if (present.some(meta => !meta)) return json({ error: 'Missing chunks' }, 400);
    // Without a display copy the original itself is shown, so it must fit one response.
    if (!record.preview && record.size > MAX_PREVIEW_BYTES) return json({ error: 'Display copy missing' }, 400);
    const done = { ...record, complete: true, uploadedAt: Date.now() };
    await store.records.setJSON(id, done);
    context?.waitUntil?.(removeUnusedImages(ns, sheet).catch(err => console.error('Image cleanup failed', err)));
    return json({ src: `/.netlify/functions/images?sheet=${sheet}&id=${id}` });
  }

  // A locked image from before types were locked: its types, locked. Never replaces a locked type.
  if (req.method === 'POST' && action === 'seal-type') {
    const body = await req.json().catch(() => null);
    if (!record.enc || isSealed(record.type)) return json({ ok: true });
    if (!isSealed(body?.type) || (record.preview && !isSealed(body?.preview))) return json({ error: 'Bad type' }, 400);
    await store.records.setJSON(id, { ...record, type: body.type, ...(record.preview ? { preview: { ...record.preview, type: body.preview } } : {}) });
    return json({ ok: true });
  }

  // Erasing an image from before encryption once its locked copy replaced it in the text.
  if (req.method === 'DELETE') {
    if (record.enc) return json({ error: 'Not allowed' }, 405);
    await deleteImage(store, record);
    return json({ ok: true });
  }

  if (req.method !== 'GET' || !record.complete) return json({ error: 'Not allowed' }, 405);

  // Details of the original, for saving it.
  if (url.searchParams.get('info') === '1') {
    return json({ type: record.type, size: record.size, chunks: record.chunks, enc: Boolean(record.enc), preview: record.preview?.type || null });
  }

  // One chunk of the original.
  if (chunkIndex !== null) {
    const data = await store.chunks.get(chunkKey(id, chunkIndex), { type: 'arrayBuffer' });
    if (!data) return json({ error: 'Chunk missing' }, 404);
    return new Response(data, { headers: imageHeaders('application/octet-stream') });
  }

  // What the text shows: the display copy, or the small original itself.
  if (record.preview) {
    const data = await store.previews.get(id, { type: 'arrayBuffer' });
    if (data) return new Response(data, { headers: imageHeaders(record.enc ? 'application/octet-stream' : record.preview.type, record.enc ? record.preview.type : null) });
  }
  const data = await store.chunks.get(chunkKey(id, 0), { type: 'arrayBuffer' });
  if (!data) return json({ error: 'Image missing' }, 404);
  return new Response(data, { headers: imageHeaders(record.enc ? 'application/octet-stream' : record.type, record.enc ? record.type : null) });
};
