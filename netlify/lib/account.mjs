import { MAX_SHEETS, authStore, emailKey, notifySync, userStore } from './auth.mjs';
import { wipeSheet } from './files.mjs';
import { playKeepsPro } from './plans.mjs';
import { cancelSubscription as cancelPlay, forgetToken as forgetPlayToken, playReady } from './play.mjs';
import { readShares, sharesStore } from './shares.mjs';
import { customerKey, stripe, stripeReady } from './stripe.mjs';

// Every sheet slot (text, files, images), the account's lists and markers,
// and its share links.
export async function deleteAccountData(ns) {
  const shares = await readShares(ns);
  const links = sharesStore();
  await Promise.all(shares.map(async s => {
    const { blobs } = await links.list({ prefix: `count/${s.token}/` });
    await Promise.all([links.delete(`shares/${s.token}`), ...blobs.map(({ key }) => links.delete(key))]);
  }));
  await Promise.all(Array.from({ length: MAX_SHEETS }, (_, i) => wipeSheet(ns, i + 1)));
  const state = userStore(ns, 'state');
  const { blobs } = await state.list();
  await Promise.all(blobs.map(({ key }) => state.delete(key)));
}

// Deletes an account and everything in it, the same way whoever asks (the
// owner in the app, or support from the admin dashboard). A paying
// subscription (Stripe or Google Play) is cancelled first, and if that fails
// nothing is deleted, so nobody keeps paying for nothing.
// → { cancelled } or { error, status }
export async function deleteAccount(user) {
  const store = authStore();
  const ek = emailKey(user.email);
  const sub = user.stripe?.subscription;
  const stripeRenews = Boolean(sub && !['canceled', 'incomplete_expired'].includes(user.stripe.status));
  if (stripeRenews) {
    if (!stripeReady()) return { error: 'Couldn’t cancel the Pro subscription. Try again later, or email support.', status: 503 };
    try {
      await stripe('DELETE', `subscriptions/${sub}`);
    } catch (err) {
      // Already gone at Stripe is fine.
      if (err.status !== 404) {
        console.error('Cancel on delete', err.status, err.message);
        return { error: 'Couldn’t cancel the Pro subscription. Try again in a minute, or email support.', status: 502 };
      }
    }
  }
  // Pro bought in the Android app renews through Google Play: stopped too.
  const playRenews = Boolean(user.play?.token && user.play.autoRenew && playKeepsPro(user.play));
  if (playRenews) {
    if (!playReady()) return { error: 'Couldn’t cancel the Google Play subscription. Try again later, or email support.', status: 503 };
    try {
      await cancelPlay(user.play.token);
    } catch (err) {
      if (![404, 410].includes(err.status)) {
        console.error('Play cancel on delete', err.status, err.message);
        return { error: 'Couldn’t cancel the Google Play subscription. Try again in a minute, or email support.', status: 502 };
      }
    }
  }
  await deleteAccountData(user.ns);
  await Promise.all([`users/${ek}`, `codes/${ek}`, `pending/${ek}`].map(key => store.delete(key)));
  if (user.stripe?.customer) await store.delete(customerKey(user.stripe.customer));
  if (user.play?.token) await forgetPlayToken(user.play.token);
  // Other devices check in and find the account gone.
  await notifySync(user.ns, 'session', String(Date.now()));
  return { cancelled: stripeRenews || playRenews };
}
