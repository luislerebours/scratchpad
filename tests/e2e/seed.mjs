// Writes data in the old single-user format, as the live site has it today.
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { getStore } = await import(REPO + '/node_modules/@netlify/blobs/dist/main.js');
const opts = name => ({ name, siteID: 'site', token: 'tok', apiURL: 'http://localhost:8971', consistency: 'strong' });
const st = getStore(opts('scratchpad'));
await st.setJSON('sheets/1', { text: 'owner sheet one', updatedAt: Date.now() });
await st.setJSON('sheets/2', { text: 'owner groceries', html: 'owner groceries', updatedAt: Date.now() });
await st.setJSON('meta/names', { names: ['Inbox', 'Groceries', 'Sheet 3', 'Work', 'Sheet 5'], updatedAt: Date.now() });
await st.setJSON('meta/current', { sheet: 2, updatedAt: Date.now() });
await getStore(opts('scratchpad-files-2')).setJSON('legacyfile', { id: 'legacyfile', name: 'receipt.pdf', type: 'application/pdf', size: 5, chunkSize: 4000000, chunks: 1, complete: true, startedAt: 1, uploadedAt: Date.now() });
await getStore(opts('scratchpad-chunks-2')).set('legacyfile-0', 'hello');
console.log('seeded legacy owner data');
