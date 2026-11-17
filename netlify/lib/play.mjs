import { createHash, createSign, timingSafeEqual } from 'node:crypto';
import { authStore, env } from './auth.mjs';
import { playKeepsPro, stripeKeepsPro } from './plans.mjs';

// Google Play Billing, for Pro bought inside the Android app (a Trusted Web
// Activity: the page buys through Chrome's Digital Goods API, then sends the
// purchase token here). Through the Google Play Developer API (no SDK):
//   PLAY_PACKAGE_NAME      the Android app's package, e.g. com.sector809labs.scrapsheet
//   PLAY_SERVICE_ACCOUNT   the JSON key of a Google Cloud service account that
//                          Play Console lets view financial data and manage orders
//   PLAY_RTDN_SECRET       a long random string, the ?key= on the Pub/Sub push URL
// Subscriptions (one base plan each) use the same ids as Stripe's lookup keys.
export const PLAY_PRODUCTS = { month: 'scrapsheet_pro_month', year: 'scrapsheet_pro_year' };
const INTERVAL_OF = Object.fromEntries(Object.entries(PLAY_PRODUCTS).map(([k, v]) => [v, k]));

// Local tests point these at a stand-in for Google.
const API = () => env('PLAY_API_BASE') || 'https://androidpublisher.googleapis.com';
const packageName = () => env('PLAY_PACKAGE_NAME');

function serviceAccount() {
  try {
    const key = JSON.parse(env('PLAY_SERVICE_ACCOUNT') || '');
    return key.client_email && key.private_key ? key : null;
  } catch {
    return null;
  }
}

export const playReady = () => Boolean(packageName() && serviceAccount());

// ---- Access token: a JWT signed with the service account's key ----

let cached = null;
const b64url = data => Buffer.from(data).toString('base64url');

async function accessToken() {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const key = serviceAccount();
  const tokenUri = env('PLAY_TOKEN_URL') || key.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: tokenUri, iat: now, exp: now + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(key.private_key).toString('base64url');
  const r = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw Object.assign(new Error(`Google token ${r.status}`), { status: 502 });
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}

async function play(method, path, body) {
  const r = await fetch(`${API()}/androidpublisher/v3/applications/${encodeURIComponent(packageName())}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || `Google Play ${r.status}`), { status: r.status });
  return data;
}

export const getSubscription = token => play('GET', `purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`);
const acknowledge = (productId, token) => play('POST', `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`, {});
// Used when the account is deleted: no more charges.
export const cancelSubscription = token => play('POST', `purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}:cancel`, { cancellationContext: { cancellationType: 'DEVELOPER_REQUESTED_STOP_PAYMENTS' } });

// ---- What a subscription means for the account ----

// Our subscription's line, or null for anything that isn't ScrapSheet Pro.
const proLine = sub => (sub?.lineItems || []).find(item => INTERVAL_OF[item.productId]) || null;

// Purchase tokens are long and private: the index keeps only a hash.
const tokenKey = token => `play-tokens/${createHash('sha256').update(String(token)).digest('hex')}`;

export const forgetToken = token => authStore().delete(tokenKey(token));
// Linked before it pays (a pending payment), so Google's notice finds the account.
export const linkToken = (token, ek) => authStore().set(tokenKey(token), ek);

export async function accountForToken(token, sub = null) {
  const store = authStore();
  const ek = await store.get(tokenKey(token));
  if (ek) return ek;
  // A resubscribe or plan change carries the token it replaces.
  if (sub?.linkedPurchaseToken) return store.get(tokenKey(sub.linkedPurchaseToken));
  return null;
}

// Records a subscription on its account and sets the plan to match. A Stripe
// subscription that still pays for Pro keeps it, whatever Play says.
export async function applyPlay(ek, token, sub) {
  const store = authStore();
  const user = await store.get(`users/${ek}`, { type: 'json' });
  if (!user) return null;
  const line = proLine(sub);
  if (!line) return user;
  const expiresAt = line.expiryTime ? Date.parse(line.expiryTime) : null;
  // A different purchase that has ended (say, the one a plan change replaced)
  // doesn't undo the one that still pays.
  if (user.play?.token && user.play.token !== token && playKeepsPro(user.play) && !playKeepsPro({ state: sub.subscriptionState, expiresAt })) {
    await store.set(tokenKey(token), ek);
    return user;
  }
  const playState = {
    token,
    productId: line.productId,
    interval: INTERVAL_OF[line.productId],
    state: sub.subscriptionState,
    expiresAt,
    autoRenew: Boolean(line.autoRenewingPlan?.autoRenewEnabled),
    acknowledged: sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    test: Boolean(sub.testPurchase),
    updatedAt: Date.now()
  };
  const updated = { ...user, plan: playKeepsPro(playState) || stripeKeepsPro(user.stripe) ? 'pro' : 'free', play: playState };
  await store.setJSON(`users/${ek}`, updated);
  await store.set(tokenKey(token), ek);
  return updated;
}

// Google refunds a purchase that isn't acknowledged within 3 days.
export async function acknowledgeIfNeeded(token, sub) {
  const line = proLine(sub);
  if (!line || sub.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_PENDING') return false;
  if (!['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'].includes(sub.subscriptionState)) return false;
  await acknowledge(line.productId, token);
  return true;
}

export const isProSubscription = sub => Boolean(proLine(sub));

export function rtdnKeyOk(given) {
  const secret = env('PLAY_RTDN_SECRET');
  if (!secret || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

