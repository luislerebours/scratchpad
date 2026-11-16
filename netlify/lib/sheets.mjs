// The account's sheets, shared by state.mjs and share.mjs.

// A name as typed (40 characters at most), or one locked by the page
// ("e1:…", end-to-end encrypted), which is kept exactly as sent.
export const isSealed = value => typeof value === 'string' && /^e1:[A-Za-z0-9_-]{1,2000}$/.test(value);
export const cleanName = value => isSealed(value) ? value : String(value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);
// A sheet or file key, locked by the page with a key we don't have.
export const isWrappedKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{40,120}$/.test(value);

// The account's sheets, in tab order. Accounts made before sheets could be
// added had five fixed sheets with names in meta/names.
// New accounts start with `start` sheets (5 on Pro, 1 on Free).
export async function readSheets(store, start = 5) {
  const data = await store.get('meta/sheets', { type: 'json' });
  if (data?.sheets?.length) return data;
  const legacy = await store.get('meta/names', { type: 'json' });
  if (legacy) {
    const names = Array.from({ length: 5 }, (_, i) => cleanName(legacy.names?.[i]) || `Sheet ${i + 1}`);
    return { sheets: names.map((name, i) => ({ id: i + 1, name })), updatedAt: Number(legacy.updatedAt || 0) };
  }
  return { sheets: Array.from({ length: start }, (_, i) => ({ id: i + 1, name: `Sheet ${i + 1}` })), updatedAt: 0 };
}
