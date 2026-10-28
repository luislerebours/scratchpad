import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

// Images pasted into a sheet's text. Each request carries one whole image,
// so the client shrinks anything bigger than MAX_IMAGE_BYTES before sending.
const SHEET_COUNT = 5;
const MAX_IMAGE_BYTES = 4 * 1000 * 1000;
const UNUSED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif']);

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
const imageStore = sheet => getStore({ name: `scratchpad-images-${sheet}`, consistency: 'strong' });

// Deletes this sheet's images that no sheet's text has used for a week.
// Every sheet is checked because text (and its images) can move between sheets.
async function removeUnusedImages(sheet) {
  const state = getStore({ name: 'scratchpad', consistency: 'strong' });
  const docs = await Promise.all(
    Array.from({ length: SHEET_COUNT }, (_, i) => state.get(`sheets/${i + 1}`, { type: 'json' }))
  );
  const used = new Set();
  for (const doc of docs) {
    for (const match of String(doc?.html || '').matchAll(/[?&;]id=([A-Za-z0-9-]{1,64})/g)) used.add(match[1]);
  }

  const store = imageStore(sheet);
  const { blobs } = await store.list();
  await Promise.all(blobs.map(async ({ key }) => {
    if (used.has(key)) return;
    const meta = await store.getMetadata(key);
    if (Date.now() - Number(meta?.metadata?.uploadedAt || 0) > UNUSED_GRACE_MS) await store.delete(key);
  }));
}

export default async (req, context) => {
  const url = new URL(req.url);
  const sheet = parseSheet(url.searchParams.get('sheet'));
  if (!sheet) return json({ error: 'Invalid sheet' }, 400);
  const store = imageStore(sheet);

  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!validId(id)) return json({ error: 'Invalid id' }, 400);
    const entry = await store.getWithMetadata(id, { type: 'arrayBuffer' });
    if (!entry) return json({ error: 'Not found' }, 404);
    // An id always names the same bytes, so the image can be cached for good.
    return new Response(entry.data, {
      headers: {
        'Content-Type': entry.metadata?.type || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Netlify-CDN-Cache-Control': 'public, durable, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }

  if (req.method === 'POST') {
    const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!TYPES.has(type)) return json({ error: 'Unsupported image type' }, 415);
    const data = await req.arrayBuffer();
    if (!data.byteLength) return json({ error: 'Empty image' }, 400);
    if (data.byteLength > MAX_IMAGE_BYTES) return json({ error: 'Image too large' }, 413);

    const id = randomUUID();
    await store.set(id, data, { metadata: { type, size: data.byteLength, uploadedAt: Date.now() } });
    context?.waitUntil?.(removeUnusedImages(sheet).catch(err => console.error('Image cleanup failed', err)));
    return json({ id, src: `/.netlify/functions/images?sheet=${sheet}&id=${id}` });
  }

  return json({ error: 'Method not allowed' }, 405);
};
