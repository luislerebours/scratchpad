import { userStore } from './auth.mjs';

// Earlier versions of a sheet's text, so a mistake (clearing it, pasting over
// it, two devices typing at once) can be undone. Before a save replaces the
// text, the text being replaced is kept as a version: at most once every 10
// minutes while typing goes on, and always before a big change the page flags
// (`checkpoint`: clearing, most of the text gone, restoring a version). Up to
// 20 per sheet, for 30 days. Locked text stays locked: versions are copies of
// what was stored. They count toward storage, and the images they use are kept.
//
// In the account's state store: `versions/<sheet>/<savedAt>` holds a copy of the
// sheet as stored, and `vindex/<sheet>` lists them, newest first:
// [{ at, takenAt, size, images }].

const EVERY_MS = 10 * 60 * 1000;
const KEEP = 20;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const indexKey = sheet => `vindex/${sheet}`;
const versionKey = (sheet, at) => `versions/${sheet}/${at}`;

const imagesOf = doc => Array.isArray(doc.images)
  ? doc.images
  : [...String(doc.html || '').matchAll(/[?&;]id=([A-Za-z0-9-]{1,64})/g)].map(m => m[1]);
const sizeOf = doc => Buffer.byteLength(doc.text || '') + Buffer.byteLength(doc.html || '');
const hasContent = doc => Boolean(doc && (doc.html || doc.text));

async function readIndex(state, sheet) {
  const list = await state.get(indexKey(sheet), { type: 'json' }).catch(() => null);
  return Array.isArray(list) ? list : [];
}

// Drops versions past 30 days or beyond the newest 20.
async function trim(state, sheet, list) {
  const now = Date.now();
  const keep = list.filter((v, i) => i < KEEP && now - v.takenAt < KEEP_MS);
  const gone = list.filter(v => !keep.includes(v));
  if (gone.length) await Promise.all(gone.map(v => state.delete(versionKey(sheet, v.at))));
  return { keep, changed: gone.length > 0 };
}

// Called just before a save replaces the sheet's text.
export async function keepVersion(ns, sheet, { checkpoint = false } = {}) {
  const state = userStore(ns, 'state');
  let list = await readIndex(state, sheet);
  if (!checkpoint && list[0] && Date.now() - list[0].takenAt < EVERY_MS) return;
  const doc = await state.get(`sheets/${sheet}`, { type: 'json' });
  if (!hasContent(doc)) return;
  const at = Number(doc.updatedAt) || Date.now();
  if (list.some(v => v.at === at)) return; // already kept
  await state.setJSON(versionKey(sheet, at), doc);
  list = [{ at, takenAt: Date.now(), size: sizeOf(doc), images: imagesOf(doc) }, ...list];
  ({ keep: list } = await trim(state, sheet, list));
  await state.setJSON(indexKey(sheet), list);
}

export async function listVersions(ns, sheet) {
  const state = userStore(ns, 'state');
  const { keep, changed } = await trim(state, sheet, await readIndex(state, sheet));
  if (changed) await state.setJSON(indexKey(sheet), keep);
  return keep.map(({ at, size }) => ({ at, size }));
}

export async function readVersion(ns, sheet, at) {
  const doc = await userStore(ns, 'state').get(versionKey(sheet, at), { type: 'json' });
  return doc ? { html: doc.html ?? null, text: doc.text || '', at } : null;
}

// Sizes and images of every sheet's versions (for storage and image cleanup).
export async function versionsSummary(ns, sheets) {
  const state = userStore(ns, 'state');
  const lists = await Promise.all(sheets.map(sheet => readIndex(state, sheet)));
  const images = new Set();
  let bytes = 0;
  for (const list of lists) for (const v of list) {
    bytes += v.size || 0;
    (v.images || []).forEach(id => images.add(id));
  }
  return { bytes, images };
}

// A sheet slot wiped for good: its versions go too.
export async function clearVersions(ns, sheet) {
  const state = userStore(ns, 'state');
  const list = await readIndex(state, sheet);
  await Promise.all(list.map(v => state.delete(versionKey(sheet, v.at))));
  await state.delete(indexKey(sheet));
}
