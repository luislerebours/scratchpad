// The account's sheets, shared by state.mjs and share.mjs.

export const cleanName = value => String(value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);

// The account's sheets, in tab order. Accounts made before sheets could be
// added had five fixed sheets with names in meta/names.
export async function readSheets(store) {
  const data = await store.get('meta/sheets', { type: 'json' });
  if (data?.sheets?.length) return data;
  const legacy = await store.get('meta/names', { type: 'json' });
  if (legacy) {
    const names = Array.from({ length: 5 }, (_, i) => cleanName(legacy.names?.[i]) || `Sheet ${i + 1}`);
    return { sheets: names.map((name, i) => ({ id: i + 1, name })), updatedAt: Number(legacy.updatedAt || 0) };
  }
  return { sheets: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `Sheet ${i + 1}` })), updatedAt: 0 };
}
