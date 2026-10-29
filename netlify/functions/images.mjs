import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

// Images pasted into a sheet's text. Netlify functions take about 4.5 MB per
// request, so each image is kept twice: the untouched original in 4 MB chunks
// (up to 100 MB), and a small display copy the page makes before uploading,
// which is what the text shows. Small images skip the copy and show as-is.
const SHEET_COUNT = 5;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1000 * 1000;
const CHUNK_BYTES = 4 * 1000 * 1000;
const UNUSED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif']);
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

const parseSheet = value => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= SHEET_COUNT ? n : null;
};

const validId = id => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
const chunkKey = (id, index) => `${id}-${index}`;

const stores = sheet => ({
  records: getStore({ name: `scratchpad-images-${sheet}`, consistency: 'strong' }),
  chunks: getStore({ name: `scratchpad-image-chunks-${sheet}`, consistency: 'strong' }),
  previews: getStore({ name: `scratchpad-image-previews-${sheet}`, consistency: 'strong' })
});

// An id always names the same bytes, so responses can be cached for good.
const imageHeaders = type => ({
  'Content-Type': type,
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Netlify-CDN-Cache-Control': 'public, durable, max-age=31536000, immutable',
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
async function removeUnusedImages(sheet) {
  const state = getStore({ name: 'scratchpad', consistency: 'strong' });
  const docs = await Promise.all(
    Array.from({ length: SHEET_COUNT }, (_, i) => state.get(`sheets/${i + 1}`, { type: 'json' }))
  );
  const used = new Set();
  for (const doc of docs) {
    for (const match of String(doc?.html || '').matchAll(/[?&;]id=([A-Za-z0-9-]{1,64})/g)) used.add(match[1]);
  }

  const store = stores(sheet);
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
  const url = new URL(req.url);
  const sheet = parseSheet(url.searchParams.get('sheet'));
  if (!sheet) return json({ error: 'Invalid sheet' }, 400);
  const store = stores(sheet);
  const id = url.searchParams.get('id');
  const action = url.searchParams.get('action');

  // Start an upload: reserve an id and tell the page how to chunk it.
  if (req.method === 'POST' && action === 'start') {
    const body = await req.json().catch(() => null);
    const type = String(body?.type || '').toLowerCase();
    const size = Number(body?.size);
    if (!TYPES.has(type)) return json({ error: 'Unsupported image type' }, 415);
    if (!Number.isInteger(size) || size <= 0) return json({ error: 'Invalid size' }, 400);
    if (size > MAX_IMAGE_BYTES) return json({ error: 'Image is over 100 MB' }, 413);

    const record = {
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
      const expected = Math.min(record.chunkSize, record.size - chunkIndex * record.chunkSize);
      if (data.byteLength !== expected) return json({ error: 'Wrong chunk size' }, 400);
      await store.chunks.set(chunkKey(id, chunkIndex), data);
      return json({ ok: true });
    }
    if (url.searchParams.get('preview') === '1') {
      const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!PREVIEW_TYPES.has(type)) return json({ error: 'Unsupported preview type' }, 415);
      if (!data.byteLength || data.byteLength > MAX_PREVIEW_BYTES) return json({ error: 'Preview too large' }, 413);
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
    context?.waitUntil?.(removeUnusedImages(sheet).catch(err => console.error('Image cleanup failed', err)));
    return json({ src: `/.netlify/functions/images?sheet=${sheet}&id=${id}` });
  }

  if (req.method !== 'GET' || !record.complete) return json({ error: 'Not allowed' }, 405);

  // Details of the original, for saving it.
  if (url.searchParams.get('info') === '1') {
    return json({ type: record.type, size: record.size, chunks: record.chunks });
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
    if (data) return new Response(data, { headers: imageHeaders(record.preview.type) });
  }
  const data = await store.chunks.get(chunkKey(id, 0), { type: 'arrayBuffer' });
  if (!data) return json({ error: 'Image missing' }, 404);
  return new Response(data, { headers: imageHeaders(record.type) });
};
