// A stand-in for Google (OAuth token + Google Play Developer API), for local tests only.
//   POST /token                       checks the service account's signed JWT
//   GET  …/purchases/subscriptionsv2/tokens/{t}
//   POST …/purchases/subscriptions/{id}/tokens/{t}:acknowledge
//   POST …/purchases/subscriptionsv2/tokens/{t}:cancel
// Test controls (CORS-open, so the page's fake Google Play can make purchases):
//   POST /__buy { productId, pending? } → { token }
//   POST /__set { token, ...fields }    GET /__get?token=…    GET /__log
import http from 'node:http';
import fs from 'node:fs';
import { createVerify, randomBytes } from 'node:crypto';

const PKG = 'com.sector809labs.scrapsheet';
const PUB = fs.readFileSync(new URL('./playkey.pub.pem', import.meta.url), 'utf8');
const subs = new Map();
const log = [];
let issued = 0;

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(JSON.stringify(body));
};
const readBody = async req => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };
const days = n => new Date(Date.now() + n * 86400000).toISOString();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8972');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const body = await readBody(req);

  if (url.pathname === '/token' && req.method === 'POST') {
    const assertion = new URLSearchParams(body).get('assertion') || '';
    const [h, c, s] = assertion.split('.');
    const ok = h && c && s && createVerify('RSA-SHA256').update(`${h}.${c}`).verify(PUB, Buffer.from(s, 'base64url'));
    const claims = ok ? JSON.parse(Buffer.from(c, 'base64url')) : {};
    if (!ok || claims.scope !== 'https://www.googleapis.com/auth/androidpublisher') return send(res, 400, { error: 'invalid_grant' });
    issued++;
    return send(res, 200, { access_token: 'mock-access', expires_in: 3600, token_type: 'Bearer' });
  }

  if (url.pathname === '/__buy') {
    const { productId, pending, linked } = JSON.parse(body || '{}');
    const token = 'tok.' + randomBytes(24).toString('base64url');
    subs.set(token, {
      kind: 'androidpublisher#subscriptionPurchaseV2',
      subscriptionState: pending ? 'SUBSCRIPTION_STATE_PENDING' : 'SUBSCRIPTION_STATE_ACTIVE',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      ...(linked ? { linkedPurchaseToken: linked } : {}),
      testPurchase: {},
      lineItems: [{ productId, expiryTime: days(productId.endsWith('year') ? 365 : 30), autoRenewingPlan: { autoRenewEnabled: true }, offerDetails: { basePlanId: productId.endsWith('year') ? 'yearly' : 'monthly' } }]
    });
    return send(res, 200, { token });
  }
  if (url.pathname === '/__set') {
    const { token, ...fields } = JSON.parse(body || '{}');
    const sub = subs.get(token);
    if (!sub) return send(res, 404, {});
    const { autoRenew, expiresInDays, ...rest } = fields;
    Object.assign(sub, rest);
    if (autoRenew !== undefined) sub.lineItems[0].autoRenewingPlan = { autoRenewEnabled: autoRenew };
    if (expiresInDays !== undefined) sub.lineItems[0].expiryTime = days(expiresInDays);
    return send(res, 200, sub);
  }
  if (url.pathname === '/__get') return send(res, subs.has(url.searchParams.get('token')) ? 200 : 404, subs.get(url.searchParams.get('token')) || {});
  if (url.pathname === '/__log') return send(res, 200, { log, issued });

  // The Google Play Developer API
  const base = `/androidpublisher/v3/applications/${PKG}/purchases/`;
  if (!url.pathname.startsWith(base)) return send(res, 404, { error: { message: 'Not found (package?)' } });
  if (req.headers.authorization !== 'Bearer mock-access') return send(res, 401, { error: { message: 'Unauthorized' } });
  const rest = decodeURIComponent(url.pathname.slice(base.length));
  let m;
  if (req.method === 'GET' && (m = rest.match(/^subscriptionsv2\/tokens\/(.+)$/))) {
    log.push(`get ${m[1].slice(0, 10)}`);
    return subs.has(m[1]) ? send(res, 200, subs.get(m[1])) : send(res, 404, { error: { message: 'The purchase token was not found.' } });
  }
  if (req.method === 'POST' && (m = rest.match(/^subscriptions\/([^/]+)\/tokens\/(.+):acknowledge$/))) {
    const sub = subs.get(m[2]);
    if (!sub) return send(res, 404, { error: { message: 'Not found' } });
    log.push(`ack ${m[1]}`);
    sub.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    return send(res, 200, {});
  }
  if (req.method === 'POST' && (m = rest.match(/^subscriptionsv2\/tokens\/(.+):cancel$/))) {
    const sub = subs.get(m[1]);
    if (!sub) return send(res, 404, { error: { message: 'Not found' } });
    log.push(`cancel ${JSON.parse(body || '{}').cancellationContext?.cancellationType}`);
    sub.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
    sub.lineItems[0].autoRenewingPlan = { autoRenewEnabled: false };
    return send(res, 200, {});
  }
  return send(res, 404, { error: { message: 'Unknown call' } });
}).listen(8972, () => console.log('play mock ready'));
