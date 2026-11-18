import { env, signForSync } from './auth.mjs';

// File pieces in Cloudflare R2, through the sync relay (sync-worker/), which
// has the bucket bound and checks passes Netlify signs with the sync key.
// Downloads from R2 cost nothing; from Netlify they're metered per GB.
//
// On when FILES_R2=1 and SYNC_URL is set: new uploads go to R2 (records get
// `store: 'r2'`). Files uploaded before stay in Netlify Blobs and keep working.
// Pieces are end-to-end encrypted on the device, so R2 only ever holds
// ciphertext. Keys: files/<ns>/<sheet>/<file id>/<piece>.

const DAY = 24 * 60 * 60 * 1000;
const base = () => (env('SYNC_URL') || '').replace(/\/$/, '');

export const r2Enabled = () => env('FILES_R2') === '1' && Boolean(base());
export const onR2 = record => record?.store === 'r2';

export const filePrefix = (ns, sheet, id) => `files/${ns}/${sheet}/${id}`;
export const sheetPrefix = (ns, sheet) => `files/${ns}/${sheet}/`;

const pass = (prefix, op, extra = {}, exp = Date.now() + 10 * 60_000) =>
  signForSync({ k: 'file', r: prefix, op, ...extra, exp });

// Where the page sends each piece: PUT `${url}&i=<piece>`, for a day (as long
// as an unfinished upload is kept).
export async function uploadTarget(ns, sheet, record, maxPieceBytes) {
  const t = await pass(filePrefix(ns, sheet, record.id), 'up', { n: record.chunks, max: maxPieceBytes }, Date.now() + DAY);
  return { url: `${base()}/files/up?t=${encodeURIComponent(t)}` };
}

// One piece to download. The pass lasts until the end of the next day and is
// the same all day (Ed25519 signatures are deterministic), so the browser can
// keep the piece it already downloaded.
export async function pieceUrl(ns, sheet, record, index) {
  const exp = (Math.floor(Date.now() / DAY) + 2) * DAY;
  const t = await pass(filePrefix(ns, sheet, record.id), 'get', { n: record.chunks }, exp);
  return `${base()}/files/get?t=${encodeURIComponent(t)}&i=${index}`;
}

async function call(op, prefix, extra) {
  const r = await fetch(`${base()}/files/${op}`, { method: 'POST', body: await pass(prefix, op, extra), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`R2 ${op} ${r.status}`);
  return r.json();
}

// Sizes of the pieces R2 has (null for a missing one), to finish an upload.
export const pieceSizes = (ns, sheet, record) => call('check', filePrefix(ns, sheet, record.id), { n: record.chunks }).then(d => d.sizes);

export const deletePieces = (prefix, n) => call('delete', prefix, { n });

// Everything under a prefix (a sheet's slot, when it's wiped).
export async function purge(prefix) {
  for (let i = 0; i < 1000; i++) {
    const { more } = await call('purge', prefix, {});
    if (!more) return;
  }
}
