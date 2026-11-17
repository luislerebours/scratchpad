import { json } from './auth.mjs';

// Free and Pro. Accounts made before plans existed have no `plan` and stay
// Pro; new accounts start on Free. Paying through Stripe sets `plan: 'pro'`,
// and a subscription ending sets it back to 'free'. Every account follows its
// plan: admin rights live in the admin dashboard and never change it. Limits apply to adding things: an account that drops to
// Free keeps everything it has, but can't add past Free's limits.

const MB = 1024 ** 2;

export const PLANS = {
  free: { name: 'Free', sheets: 1, files: 1, fileBytes: 10 * MB, quotaBytes: 10 * MB, share: false },
  pro: { name: 'Pro', sheets: 10, files: Infinity, fileBytes: 100 * MB, quotaBytes: 5 * 1024 * MB, share: true }
};

// What Pro costs, for the page (Stripe holds the real prices).
export const PRICES = { month: 0.99, year: 9.99 };

export function planOf(user) {
  return user?.plan === 'free' ? 'free' : 'pro';
}

export const limitsFor = user => PLANS[planOf(user)];

// What the page needs to know about the plan and billing.
export function planInfo(user) {
  const plan = planOf(user);
  const { name, sheets, files, fileBytes, quotaBytes, share } = PLANS[plan];
  const billing = user?.stripe?.customer ? {
    interval: user.stripe.interval || null,
    status: user.stripe.status || null,
    renewsAt: user.stripe.periodEnd || null,
    cancelsAtEnd: Boolean(user.stripe.cancelAtEnd)
  } : null;
  return { plan, name, sheets, files: Number.isFinite(files) ? files : null, fileBytes, quotaBytes, share, billing, prices: PRICES };
}

// A Pro feature or limit was hit: the page shows its upgrade card.
export const needsPro = error => json({ error, upgrade: true }, 403);
