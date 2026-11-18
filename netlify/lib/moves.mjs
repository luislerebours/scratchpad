import { authStore } from './auth.mjs';
import { customerKey, stripe } from './stripe.mjs';
import { linkToken } from './play.mjs';

// An account that moved to a new email (Change email) is stored under its new
// email key; `email-moves/<old>` points there, so anything that still knows it
// by the old key (a Stripe subscription's metadata, a Google Play token, a
// late notice) finds it.

// The key an account is stored under now: as given, or where it moved to.
export async function currentUserKey(ek) {
  const store = authStore();
  let key = ek;
  for (let hops = 0; key && hops < 5; hops++) {
    if (await store.get(`users/${key}`)) return key;
    key = await store.get(`email-moves/${key}`);
  }
  return null;
}

// Points Stripe and Google Play at the account's new email key. Stripe's own
// copy of the email and metadata is updated too; if that fails, the moves
// record above still finds the account.
export async function followEmail(user, oldEk, newEk) {
  const store = authStore();
  const customer = user.stripe?.customer;
  if (customer) {
    await store.set(customerKey(customer), newEk);
    await stripe('POST', `customers/${customer}`, { email: user.email, metadata: { ek: newEk } })
      .catch(err => console.error('Updating the Stripe customer failed:', err.message));
    if (user.stripe?.subscription) {
      await stripe('POST', `subscriptions/${user.stripe.subscription}`, { metadata: { ek: newEk } })
        .catch(err => console.error('Updating the Stripe subscription failed:', err.message));
    }
  }
  if (user.play?.token) await linkToken(user.play.token, newEk);
}
