// Rate limits: still enforced, keys stored hashed (no email or IP readable),
// counters older than a day cleared.
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ apiURL: 'http://localhost:8971', siteID: 'site', token: 'tok' })).toString('base64');
const BASE = 'http://localhost:8970';
let fails = 0; const ok = (n, c, x = '') => { if (!c) fails++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const { authStore, pruneRates } = await import(REPO + '/netlify/lib/auth.mjs');
const store = authStore();
const email = `rate${Date.now()}@example.com`;
const ask = () => fetch(`${BASE}/.netlify/functions/auth?action=request-code`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ email }) });
const statuses = [];
for (let i = 0; i < 6; i++) statuses.push((await ask()).status);
ok('5 codes an hour for one email, the 6th refused', statuses.slice(0, 5).every(s => s === 200) && statuses[5] === 429, statuses.join(','));
const keys = (await store.list()).blobs.map(b => b.key).filter(k => k.startsWith('rate/'));
ok('rate counters exist', keys.length > 0, String(keys.length));
ok('no email or IP address readable in their names', keys.every(k => /^rate\/[0-9a-f]{64}$/.test(k)) && !keys.some(k => k.includes('@') || /\d+\.\d+\.\d+\.\d+|::1|127\.0/.test(k)), keys.slice(0, 3).join(' '));
// Old counters (one from before hashing, with a readable IP) are cleared; recent ones stay.
await store.setJSON('rate/code-ip-203.0.113.9', [Date.now() - 2 * 86400000]);
await store.setJSON('rate/' + 'a'.repeat(64), [Date.now() - 3 * 86400000]);
const cleared = await pruneRates();
const after = (await store.list()).blobs.map(b => b.key).filter(k => k.startsWith('rate/'));
ok('old counters are cleared (including readable ones from before)', cleared >= 2 && !after.includes('rate/code-ip-203.0.113.9') && !after.includes('rate/' + 'a'.repeat(64)), String(cleared));
ok('current counters stay', keys.every(k => after.includes(k)));
statuses.push((await ask()).status);
ok('…and still count: the email is still limited', statuses[6] === 429);
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
