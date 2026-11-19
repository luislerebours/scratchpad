const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { BlobsServer } = await import(REPO + '/node_modules/@netlify/blobs/dist/server.js');
const blobs = new BlobsServer({ directory: path.resolve('blobdata'), port: 8971, token: 'tok' });
await blobs.start();
// The local Blobs server answers "list every store" only at /<site>, not at the API path the client uses (real
// Netlify does): send that one request where it works (the nightly backup lists stores).
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => realFetch(typeof input === 'string' || input instanceof URL ? String(input).replace(/^(http:\/\/localhost:\d+)\/api\/v1\/blobs\/(site)(\?|$)/, '$1/$2$3') : input, init);
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ apiURL: 'http://localhost:8971', siteID: 'site', token: 'tok' })).toString('base64');
const fns = { state: (await import(REPO + '/netlify/functions/state.mjs')).default, files: (await import(REPO + '/netlify/functions/files.mjs')).default, images: (await import(REPO + '/netlify/functions/images.mjs')).default, auth: (await import(REPO + '/netlify/functions/auth.mjs')).default, ...((await fs.stat(REPO + '/netlify/functions/admin.mjs').catch(() => null)) ? { admin: (await import(REPO + '/netlify/functions/admin.mjs')).default } : {}), sync: (await import(REPO + '/netlify/functions/sync.mjs')).default, share: (await import(REPO + '/netlify/functions/share.mjs')).default, billing: (await import(REPO + '/netlify/functions/billing.mjs')).default, 'stripe-webhook': (await import(REPO + '/netlify/functions/stripe-webhook.mjs')).default, 'admin-api': (await import(REPO + '/netlify/functions/admin-api.mjs')).default, play: (await import(REPO + '/netlify/functions/play.mjs')).default, backup: (await import(REPO + '/netlify/functions/backup.mjs')).default };
// The nightly backup signs in with a token GitHub signs: here a local key stands in for GitHub's (backup.cjs reads it).
const oidc = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 });
const oidcJwks = JSON.stringify({ keys: [{ ...oidc.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] });
await fs.mkdir(new URL('./out/', import.meta.url), { recursive: true });
await fs.writeFile(new URL('./out/oidc-test-key.pem', import.meta.url), oidc.privateKey.export({ format: 'pem', type: 'pkcs8' }));
(await import(REPO + '/netlify/lib/github-oidc.mjs')).useKeysForTests('http://localhost:8970/__test/jwks');
const edgeCheck = (await import(REPO + '/netlify/edge-functions/check.js')).default;
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.webmanifest':'application/manifest+json', '.woff2':'font/woff2', '.ico':'image/x-icon', '.svg':'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost:8970'));
  if (url.pathname === '/api/check') {
    const r = await edgeCheck(new Request(url, { headers: req.headers }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  if (url.pathname === '/__test/jwks') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(oidcJwks); return; }
  if (process.env.LOG_REQ) console.log('REQ', req.method, url.pathname + url.search);
  const m = url.pathname.match(/^\/\.netlify\/functions\/([\w-]+)$/);
  try {
    if (m && fns[m[1]]) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const waits = []; const r = await fns[m[1]](new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined, duplex: 'half' }), { waitUntil: p => waits.push(p), ip: req.socket.remoteAddress }); await Promise.all(waits);
      const h = Object.fromEntries(r.headers); const sc = r.headers.getSetCookie?.(); if (sc?.length) h['set-cookie'] = sc; res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer())); return;
    }
    const p = path.join(fileURLToPath(new URL('../../public/', import.meta.url)), url.pathname === '/' ? 'index.html' : url.pathname.startsWith('/s/') ? 'share.html' : ['/privacy', '/terms', '/admin', '/delete-account', '/help'].includes(url.pathname) ? url.pathname + '.html' : url.pathname);
    const data = await fs.readFile(p); const salt = await fs.readFile(new URL('./deploy-salt.txt', import.meta.url), 'utf8').catch(() => ''); const etag = '"' + (await import('node:crypto')).createHash('md5').update(data).update(salt).digest('hex') + '"'; res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', ETag: etag, 'Cache-Control': 'public,max-age=0,must-revalidate', ...(url.pathname.startsWith('/admin') && path.extname(p) === '.html' ? { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } : {}) }); res.end(data);
  } catch (e) { console.error(e); res.writeHead(500); res.end(String(e)); }
}).listen(8970, () => console.log('ready'));
