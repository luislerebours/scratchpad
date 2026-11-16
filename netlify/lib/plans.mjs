import { isAdmin, json } from './auth.mjs';

// Free and Pro. Accounts made before plans existed have no `plan` and are Pro;
// new accounts start on Free. The owner (OWNER_EMAIL) is never limited.
// Limits apply to adding things: an account switched from Pro to Free keeps
// everything it has, but can't add past Free's limits.

const MB = 1024 ** 2;

export const PLANS = {
  free: { name: 'Free', sheets: 1, files: 1, fileBytes: 10 * MB, quotaBytes: 100 * MB, share: false },
  pro: { name: 'Pro', sheets: 10, files: Infinity, fileBytes: 100 * MB, quotaBytes: 5 * 1024 * MB, share: true }
};

export function planOf(user) {
  if (isAdmin(user)) return 'pro';
  return user?.plan === 'free' ? 'free' : 'pro';
}

export const limitsFor = user => PLANS[planOf(user)];

// What the page needs to know about the plan.
export function planInfo(user) {
  const plan = planOf(user);
  const { name, sheets, files, fileBytes, share } = PLANS[plan];
  return { plan, name, sheets, files: Number.isFinite(files) ? files : null, fileBytes, share };
}

// A Pro feature or limit was hit: the page shows its upgrade card.
export const needsPro = error => json({ error, upgrade: true }, 403);
