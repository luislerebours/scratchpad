// ScrapSheet admin dashboard. Its own sign-in (password + authenticator), its
// own API (/.netlify/functions/admin-api), which checks the admin on every
// request. Everything shown is built with textContent: account data never
// becomes markup.

const API = '/.netlify/functions/admin-api';
const $ = id => document.getElementById(id);

// ---------- Helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, params = {}, body) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${API}${qs ? `?${qs}` : ''}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !params.action?.match(/^(login|setup-start|invite-start|enroll-confirm|invite-info)$/)) {
    signedOut();
    throw new Error(data.error || 'Sign in again.');
  }
  if (!r.ok) throw Object.assign(new Error(data.error || `Error ${r.status}`), { status: r.status, data });
  return data;
}

const get = view => api('GET', { view });
const post = (action, body) => api('POST', { action }, body || {});

function size(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2).replace(/\.?0+$/, '')} GB`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtDate = t => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtTime = t => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

function ago(t) {
  if (!t) return 'never';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(t);
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

const formError = (form, text) => { form.querySelector('.ad-error').textContent = text || ''; };

async function busy(button, fn) {
  button.disabled = true;
  try { return await fn(); } finally { button.disabled = false; }
}

// ---------- Sign-in flow ----------

const GATE_CARDS = ['loading', 'loginForm', 'setupForm', 'inviteForm', 'enrollForm', 'recoveryForm', 'setupOff'];
function showCard(id) {
  $('gate').hidden = false;
  $('dash').hidden = true;
  $('who').hidden = true;
  for (const c of GATE_CARDS) $(c).hidden = c !== id;
  const first = $(id).querySelector('input:not([type=checkbox])');
  if (first) setTimeout(() => first.focus(), 0);
}

let me = null;
let enrollToken = null;
let afterCodes = null;

async function start() {
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (invite) {
    try {
      const info = await post('invite-info', { invite });
      $('inviteEmail').textContent = info.email;
      $('inviteName').value = info.name || '';
      $('inviteForm').dataset.invite = invite;
      return showCard('inviteForm');
    } catch (err) {
      $('loginForm').querySelector('.ad-error').textContent = err.message;
    }
    history.replaceState(null, '', location.pathname);
  }
  try {
    const { admin } = await get('me');
    return signedIn(admin);
  } catch {
    // Not signed in: sign-in, or first-time setup.
  }
  const { setup } = await api('GET', { action: 'status' }).catch(() => ({ setup: 'done' }));
  showCard(setup === 'open' ? 'setupForm' : setup === 'off' ? 'setupOff' : 'loginForm');
}

function signedOut() {
  me = null;
  showCard('loginForm');
}

$('loginToggle').addEventListener('click', () => {
  const useRecovery = $('loginRecoveryRow').hidden;
  $('loginRecoveryRow').hidden = !useRecovery;
  $('loginCodeRow').hidden = useRecovery;
  $('loginToggle').textContent = useRecovery ? 'Use your authenticator app instead' : 'Use a recovery code instead';
  (useRecovery ? $('loginRecovery') : $('loginCode')).focus();
});

for (const btn of document.querySelectorAll('[data-show]')) btn.addEventListener('click', () => showCard(btn.dataset.show));

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  formError(form, '');
  const useRecovery = !$('loginRecoveryRow').hidden;
  const body = { email: $('loginEmail').value, password: $('loginPassword').value };
  if (useRecovery) body.recovery = $('loginRecovery').value;
  else body.code = $('loginCode').value;
  if (!body.email || !body.password || !(body.code || body.recovery)) return formError(form, 'Fill in every field.');
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      const { admin } = await post('login', body);
      $('loginPassword').value = '';
      $('loginCode').value = '';
      $('loginRecovery').value = '';
      signedIn(admin);
      if (useRecovery && admin.recoveryLeft <= 3) toast(`${admin.recoveryLeft} recovery codes left. Make new ones under Admins.`);
    } catch (err) {
      formError(form, err.message);
    }
  });
});

function showEnroll(data) {
  enrollToken = data.enrollToken;
  // The QR is an SVG made on the server from the otpauth link; shown as an image, never as markup.
  $('enrollQr').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.qr)}`;
  $('enrollSecret').textContent = data.secret.match(/.{1,4}/g).join(' ');
  $('enrollCode').value = '';
  showCard('enrollForm');
}

$('setupForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  formError(form, '');
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      const data = await post('setup-start', {
        setupToken: $('setupToken').value, name: $('setupName').value, email: $('setupEmail').value, password: $('setupPassword').value
      });
      $('setupToken').value = '';
      $('setupPassword').value = '';
      showEnroll(data);
    } catch (err) {
      formError(form, err.message);
    }
  });
});

$('inviteForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  formError(form, '');
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      const data = await post('invite-start', { invite: form.dataset.invite, name: $('inviteName').value, password: $('invitePassword').value });
      $('invitePassword').value = '';
      showEnroll(data);
    } catch (err) {
      formError(form, err.message);
    }
  });
});

$('enrollForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  formError(form, '');
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      const { admin, recoveryCodes } = await post('enroll-confirm', { enrollToken, code: $('enrollCode').value });
      enrollToken = null;
      history.replaceState(null, '', location.pathname);
      showCodes(recoveryCodes, () => signedIn(admin));
    } catch (err) {
      formError(form, err.message);
    }
  });
});

let shownCodes = [];
function showCodes(codes, then) {
  shownCodes = codes;
  afterCodes = then;
  $('recoveryCodes').replaceChildren(...codes.map(c => h('li', { text: c })));
  $('codesSaved').checked = false;
  showCard('recoveryForm');
}

$('copyCodes').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shownCodes.join('\n'));
    toast('Copied');
  } catch {
    toast('Couldn’t copy. Select the codes instead.');
  }
});

$('downloadCodes').addEventListener('click', () => {
  const blob = new Blob([`ScrapSheet admin recovery codes (${location.host})\nEach works once.\n\n${shownCodes.join('\n')}\n`], { type: 'text/plain' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'scrapsheet-admin-recovery-codes.txt' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('recoveryForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!$('codesSaved').checked) return toast('Tick “I’ve saved these codes” first.');
  shownCodes = [];
  $('recoveryCodes').replaceChildren();
  const then = afterCodes;
  afterCodes = null;
  then?.();
});

$('logoutBtn').addEventListener('click', async () => {
  await post('logout').catch(() => {});
  signedOut();
});

// ---------- Dashboard ----------

function signedIn(admin) {
  me = admin;
  $('gate').hidden = true;
  $('dash').hidden = false;
  $('who').hidden = false;
  $('whoName').textContent = admin.name ? `${admin.name} · ${admin.email}` : admin.email;
  openTab(currentTab());
}

const TABS = ['overview', 'accounts', 'errors', 'audit', 'admins', 'settings'];
const currentTab = () => {
  const t = location.hash.slice(1);
  return TABS.includes(t) ? t : 'overview';
};

function openTab(tab) {
  for (const btn of document.querySelectorAll('[data-tab]')) btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
  for (const t of TABS) $(`tab-${t}`).hidden = t !== tab;
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
  LOADERS[tab]?.();
}

for (const btn of document.querySelectorAll('[data-tab]')) btn.addEventListener('click', () => openTab(btn.dataset.tab));

function emptyRow(table, text, cols) {
  $(table).querySelector('tbody').replaceChildren(h('tr', {}, h('td', { colspan: String(cols), class: 'ad-empty', text })));
}

// ---- Overview ----

let accounts = [];
let stripeMode = 'test';

async function loadAccounts() {
  const data = await get('accounts');
  accounts = data.accounts;
  stripeMode = data.stripeMode;
  return accounts;
}

async function loadOverview() {
  $('stats').replaceChildren(h('p', { class: 'ad-muted', text: 'Loading…' }));
  try {
    const [list, errs] = await Promise.all([loadAccounts(), get('errors')]);
    const week = Date.now() - 7 * 86400_000;
    const day = Date.now() - 86400_000;
    const stat = (label, value, note) => h('div', { class: 'ad-stat' }, h('span', { class: 'ad-stat-label', text: label }), h('strong', { text: String(value) }), note ? h('span', { class: 'ad-hint', text: note }) : null);
    const active = list.filter(a => !a.disabledAt);
    $('stats').replaceChildren(
      stat('Accounts', active.length, list.length - active.length ? `${list.length - active.length} deactivated` : null),
      stat('Pro', active.filter(a => a.plan === 'pro').length, `${active.filter(a => a.paying).length} paying`),
      stat('Free', active.filter(a => a.plan === 'free').length),
      stat('Active this week', active.filter(a => (a.lastSeenAt || 0) > week).length),
      stat('Storage used', size(list.reduce((s, a) => s + a.bytes, 0))),
      stat('Errors (24 h)', errs.errors.filter(e => e.at > day).length, `${errs.errors.length} in 30 days`)
    );
  } catch (err) {
    $('stats').replaceChildren(h('p', { class: 'ad-error', text: err.message }));
  }
}

// ---- Accounts ----

const PLAY_STATES = { SUBSCRIPTION_STATE_ACTIVE: 'active', SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace period', SUBSCRIPTION_STATE_ON_HOLD: 'on hold', SUBSCRIPTION_STATE_PAUSED: 'paused', SUBSCRIPTION_STATE_CANCELED: 'canceled', SUBSCRIPTION_STATE_EXPIRED: 'expired', SUBSCRIPTION_STATE_PENDING: 'pending' };

function billingText(a) {
  if (a.play && (!a.stripe || a.payingVia === 'Google Play')) {
    const p = a.play;
    const parts = ['Google Play', PLAY_STATES[p.status] || 'unknown'];
    if (p.interval) parts.push(p.interval === 'year' ? 'yearly' : 'monthly');
    if (p.periodEnd) parts.push(`${p.cancelAtEnd ? 'ends' : 'renews'} ${fmtDate(p.periodEnd)}`);
    if (p.test) parts.push('test purchase');
    return parts.join(' · ');
  }
  if (!a.stripe) return a.plan === 'pro' && !a.planSet ? 'Pro from before plans' : '—';
  const s = a.stripe;
  if (!s.status) return 'Customer, no subscription';
  const parts = [s.status.replace('_', ' ')];
  if (s.interval) parts.push(s.interval === 'year' ? 'yearly' : 'monthly');
  if (s.periodEnd) parts.push(`${s.cancelAtEnd ? 'ends' : 'renews'} ${fmtDate(s.periodEnd)}`);
  return parts.join(' · ');
}

function accountRow(a) {
  const tags = [
    a.disabledAt ? h('span', { class: 'ad-tag ad-tag-danger', text: 'Deactivated' }) : null,
    a.originalData ? h('span', { class: 'ad-tag', text: 'Original data' }) : null
  ];
  return h('tr', { class: a.disabledAt ? 'ad-row-off' : null },
    h('td', {}, h('div', { class: 'ad-email', text: a.email }), h('div', { class: 'ad-tags' }, tags), h('div', { class: 'ad-hint', text: `Joined ${fmtDate(a.createdAt)}` })),
    h('td', {}, h('span', { class: `ad-plan ad-plan-${a.plan}`, text: a.plan === 'pro' ? 'Pro' : 'Free' })),
    h('td', { class: 'ad-small', text: billingText(a) }),
    h('td', { class: 'ad-small' }, `${size(a.bytes)} of ${a.quota === null ? 'no limit' : size(a.quota)}`, h('div', { class: 'ad-hint', text: `${plural(a.files, 'file')} · ${plural(a.images, 'image')}` })),
    h('td', { class: 'ad-small' }, `Seen ${ago(a.lastSeenAt)}`, h('div', { class: 'ad-hint', text: `${a.loginCount === null ? '—' : plural(a.loginCount, 'sign-in')} · ${a.activeDays30 === null ? '—' : plural(a.activeDays30, 'day')} active in 30 d` })),
    h('td', {}, h('button', { class: 'ad-btn', type: 'button', text: 'Manage', onclick: () => openAccount(a.id) }))
  );
}

function renderAccounts() {
  const q = $('accountSearch').value.trim().toLowerCase();
  const f = $('accountFilter').value;
  const list = accounts.filter(a => (!q || a.email.includes(q)) && (
    f === 'all' || (f === 'disabled' ? a.disabledAt : !a.disabledAt && (f === 'paying' ? a.paying : a.plan === f))
  ));
  if (!list.length) return emptyRow('accountsTable', accounts.length ? 'No accounts match.' : 'No accounts yet.', 6);
  $('accountsTable').querySelector('tbody').replaceChildren(...list.map(accountRow));
}

async function loadAccountsTab() {
  emptyRow('accountsTable', 'Loading…', 6);
  try {
    await loadAccounts();
    renderAccounts();
  } catch (err) {
    emptyRow('accountsTable', err.message, 6);
  }
}

$('accountSearch').addEventListener('input', renderAccounts);
$('accountFilter').addEventListener('change', renderAccounts);
$('refreshAccounts').addEventListener('click', loadAccountsTab);

let current = null;

function fact(label, value) {
  return [h('dt', { text: label }), h('dd', { text: value })];
}

function fillAccount(a) {
  current = a;
  $('accountTitle').textContent = a.email;
  $('accountFacts').replaceChildren(
    ...fact('Status', a.disabledAt ? `Deactivated ${fmtTime(a.disabledAt)}${a.disabledBy ? ` by ${a.disabledBy}` : ''}` : 'Active'),
    ...fact('Plan', `${a.plan === 'pro' ? 'Pro' : 'Free'}${a.planSet ? '' : ' (from before plans)'}`),
    ...fact('Billing', billingText(a)),
    ...fact('Storage', `${size(a.bytes)} of ${a.quota === null ? 'no limit' : size(a.quota)}${a.quotaCustom !== null ? ' (custom)' : ''}`),
    ...fact('Items', `${plural(a.files, 'file')} · ${plural(a.images, 'image')}`),
    ...fact('Encryption', a.encrypted ? 'On (content can’t be read by admins)' : 'Not set up yet'),
    ...fact('Joined', fmtDate(a.createdAt)),
    ...fact('Last sign-in', fmtTime(a.lastLoginAt)),
    ...fact('Last seen', fmtTime(a.lastSeenAt)),
    ...fact('Sign-ins', String(a.loginCount ?? '—')),
    ...(a.originalData ? fact('Data', 'Holds the original data from before accounts') : [])
  );
  $('planSelect').value = a.plan;
  $('planHint').textContent = a.paying ? `This account pays through ${a.payingVia}: its next update sets the plan again.` : '';
  $('quotaInput').value = a.quotaCustom === null ? '' : a.quotaCustom === -1 ? '0' : String(+(a.quotaCustom / 1024 ** 3).toFixed(3));
  $('resyncBtn').disabled = !a.stripe && !a.play;
  $('resyncBtn').textContent = a.play && !a.stripe ? 'Refresh from Google Play' : 'Refresh from Stripe';
  const link = $('stripeLink');
  link.hidden = !a.stripe?.customer;
  if (a.stripe?.customer) link.href = `https://dashboard.stripe.com/${stripeMode === 'test' ? 'test/' : ''}customers/${encodeURIComponent(a.stripe.customer)}`;
  $('deactivateBtn').hidden = Boolean(a.disabledAt);
  $('reactivateBtn').hidden = !a.disabledAt;
  $('signoutBtn').disabled = Boolean(a.disabledAt);
  $('accountError').textContent = '';
}

function openAccount(id) {
  const a = accounts.find(x => x.id === id);
  if (!a) return;
  fillAccount(a);
  $('accountDialog').showModal();
}

async function accountOp(button, op, extra = {}, done) {
  $('accountError').textContent = '';
  await busy(button, async () => {
    try {
      const { account } = await post('account', { id: current.id, op, ...extra });
      accounts = accounts.map(a => (a.id === account.id ? account : a));
      fillAccount(account);
      renderAccounts();
      toast(done);
    } catch (err) {
      $('accountError').textContent = err.message;
    }
  });
}

$('planSave').addEventListener('click', e => accountOp(e.currentTarget, 'plan', { plan: $('planSelect').value }, 'Plan changed'));
$('quotaSave').addEventListener('click', e => accountOp(e.currentTarget, 'quota', { limitGb: $('quotaInput').value.trim() }, 'Storage limit saved'));
$('resyncBtn').addEventListener('click', e => accountOp(e.currentTarget, 'resync', {}, 'Billing updated'));
$('reactivateBtn').addEventListener('click', e => accountOp(e.currentTarget, 'reactivate', {}, 'Account reactivated'));

$('signoutBtn').addEventListener('click', async e => {
  const button = e.currentTarget;
  const ok = await confirmBox({ title: 'Sign out all devices?', body: [`${current.email} will need to sign in again on every device.`], ok: 'Sign out devices' });
  if (ok) accountOp(button, 'signout', {}, 'Devices signed out');
});

$('deactivateBtn').addEventListener('click', async e => {
  const button = e.currentTarget;
  const a = current;
  const body = [
    'Deactivating keeps everything the account holds (sheets, files, images, billing records), and can be undone with Reactivate. It:',
    h('ul', {},
      h('li', { text: 'signs the account out on every device;' }),
      h('li', { text: 'stops it signing in, getting codes or resetting its password;' }),
      h('li', { text: 'turns off its share links (they stay off after reactivating).' }))
  ];
  if (a.paying) body.push(h('p', { class: 'ad-warn', text: 'This account has an active Stripe subscription. Deactivating doesn’t cancel it: cancel or refund it in Stripe if needed.' }));
  const result = await confirmBox({ title: `Deactivate ${a.email}?`, body, ok: 'Deactivate', reason: true, typeToConfirm: a.email });
  if (result) accountOp(button, 'deactivate', { reason: result.reason }, 'Account deactivated');
});

// ---- Confirm box ----

function confirmBox({ title, body, ok, reason = false, typeToConfirm = null }) {
  const dialog = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmBody').replaceChildren(...body.map(b => (typeof b === 'string' ? h('p', { text: b }) : b)));
  $('confirmReasonRow').hidden = !reason;
  $('confirmReason').value = '';
  $('confirmTypeRow').hidden = !typeToConfirm;
  $('confirmType').value = '';
  $('confirmTypeLabel').textContent = typeToConfirm ? `Type ${typeToConfirm} to confirm` : '';
  $('confirmOk').textContent = ok;
  const check = () => { $('confirmOk').disabled = Boolean(typeToConfirm) && $('confirmType').value.trim().toLowerCase() !== typeToConfirm; };
  check();
  $('confirmType').oninput = check;
  dialog.showModal();
  return new Promise(resolve => {
    const finish = value => {
      $('confirmOk').onclick = null;
      $('confirmCancel').onclick = null;
      dialog.onclose = null;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    $('confirmOk').onclick = () => finish({ reason: $('confirmReason').value.trim() });
    $('confirmCancel').onclick = () => finish(null);
    dialog.onclose = () => finish(null);
  });
}

// ---- Errors ----

async function loadErrors() {
  emptyRow('errorsTable', 'Loading…', 4);
  try {
    const { errors } = await get('errors');
    if (!errors.length) return emptyRow('errorsTable', 'No errors. 🎉', 4);
    $('errorsTable').querySelector('tbody').replaceChildren(...errors.map(e => h('tr', {},
      h('td', { class: 'ad-small', text: fmtTime(e.at) }),
      h('td', { class: 'ad-small ad-mono', text: `${e.method} ${e.fn}${e.action ? ` · ${e.action}` : ''}` }),
      h('td', { class: 'ad-small', text: String(e.status) }),
      h('td', { class: 'ad-small', text: e.message })
    )));
  } catch (err) {
    emptyRow('errorsTable', err.message, 4);
  }
}

$('refreshErrors').addEventListener('click', loadErrors);
$('clearErrors').addEventListener('click', async e => {
  const button = e.currentTarget;
  if (!(await confirmBox({ title: 'Clear all errors?', body: ['They’re removed from this list. Clearing is recorded in the audit log.'], ok: 'Clear' }))) return;
  await busy(button, async () => {
    try {
      await post('errors-clear');
      toast('Errors cleared');
      loadErrors();
    } catch (err) {
      toast(err.message);
    }
  });
});

// ---- Audit log ----

const ACTIONS = {
  'admin.setup': 'Set up the first admin',
  'admin.setup-failed': 'Setup attempt failed',
  'admin.enrolled': 'Joined as admin',
  'admin.login': 'Signed in',
  'admin.login-failed': 'Sign-in failed',
  'admin.logout': 'Signed out',
  'admin.invite': 'Invited an admin',
  'admin.disable': 'Disabled an admin',
  'admin.enable': 'Re-enabled an admin',
  'admin.signout': 'Signed out an admin',
  'admin.recovery-codes': 'Made new recovery codes',
  'admin.password': 'Changed password',
  'admin.mfa-reset': 'Set up a new authenticator',
  'account.plan': 'Changed plan',
  'account.quota': 'Changed storage limit',
  'account.resync': 'Refreshed billing',
  'account.deactivate': 'Deactivated account',
  'account.reactivate': 'Reactivated account',
  'account.signout': 'Signed out account’s devices',
  'settings.change': 'Changed settings',
  'errors.clear': 'Cleared errors'
};

function auditDetails(e) {
  const parts = [];
  if (e.target) parts.push(e.target);
  if (e.from !== undefined || e.to !== undefined) {
    const v = x => (typeof x === 'number' ? size(x) : x === null ? 'no limit' : String(x));
    parts.push(`${v(e.from)} → ${v(e.to)}`);
  }
  if (e.changes) parts.push(Object.entries(e.changes).map(([k, c]) => `${k}: ${c.from} → ${c.to}`).join(', '));
  if (e.reason) parts.push(`reason: ${e.reason}`);
  if (e.method) parts.push(`with ${e.method}`);
  if (e.status) parts.push(`status ${e.status}`);
  if (e.sharesTurnedOff) parts.push(`${e.sharesTurnedOff} share links off`);
  if (e.count !== undefined) parts.push(`${e.count} removed`);
  if (e.ip) parts.push(`IP ${e.ip}`);
  return parts.join(' · ');
}

async function loadAudit() {
  emptyRow('auditTable', 'Loading…', 4);
  try {
    const { entries } = await get('audit');
    if (!entries.length) return emptyRow('auditTable', 'Nothing yet.', 4);
    $('auditTable').querySelector('tbody').replaceChildren(...entries.map(e => h('tr', { class: e.action.endsWith('failed') ? 'ad-row-warn' : null },
      h('td', { class: 'ad-small', text: fmtTime(e.at) }),
      h('td', { class: 'ad-small', text: e.admin?.email || '—' }),
      h('td', { class: 'ad-small', text: ACTIONS[e.action] || e.action }),
      h('td', { class: 'ad-small', text: auditDetails(e) })
    )));
  } catch (err) {
    emptyRow('auditTable', err.message, 4);
  }
}

$('refreshAudit').addEventListener('click', loadAudit);

// ---- Admins ----

async function loadAdmins() {
  emptyRow('adminsTable', 'Loading…', 4);
  try {
    const { admins, invites } = await get('admins');
    $('adminsTable').querySelector('tbody').replaceChildren(...admins.map(a => h('tr', { class: a.disabledAt ? 'ad-row-off' : null },
      h('td', {}, h('div', { class: 'ad-email', text: a.name ? `${a.name}` : a.email }), a.name ? h('div', { class: 'ad-hint', text: a.email }) : null,
        h('div', { class: 'ad-tags' }, a.you ? h('span', { class: 'ad-tag', text: 'You' }) : null, a.disabledAt ? h('span', { class: 'ad-tag ad-tag-danger', text: 'Disabled' }) : null)),
      h('td', { class: 'ad-small', text: ago(a.lastLoginAt) }),
      h('td', { class: 'ad-small', text: `${a.recoveryLeft} left` }),
      h('td', { class: 'ad-row-actions' },
        a.you ? null : a.disabledAt
          ? h('button', { class: 'ad-btn', type: 'button', text: 'Re-enable', onclick: e => adminOp(e.currentTarget, a, 'enable') })
          : h('button', { class: 'ad-btn ad-btn-danger', type: 'button', text: 'Disable', onclick: e => adminOp(e.currentTarget, a, 'disable') }),
        a.disabledAt ? null : h('button', { class: 'ad-btn', type: 'button', text: a.you ? 'Sign out everywhere' : 'Sign out', onclick: e => adminOp(e.currentTarget, a, 'signout') }))
    )));
    $('pendingInvites').replaceChildren(...(invites.length ? [h('h3', { text: 'Open invites' }), ...invites.map(i => h('p', { class: 'ad-hint', text: `${i.email} · by ${i.createdBy} · until ${fmtTime(i.expiresAt)}` }))] : []));
  } catch (err) {
    emptyRow('adminsTable', err.message, 4);
  }
}

async function adminOp(button, a, op) {
  const titles = { disable: `Disable ${a.email}?`, enable: `Re-enable ${a.email}?`, signout: a.you ? 'Sign out everywhere?' : `Sign out ${a.email}?` };
  const bodies = {
    disable: 'They’re signed out and can’t sign in to the dashboard until re-enabled.',
    enable: 'They can sign in again with their password and authenticator.',
    signout: a.you ? 'Every dashboard session of yours ends, including this one.' : 'Their dashboard sessions end; they can sign in again.'
  };
  if (!(await confirmBox({ title: titles[op], body: [bodies[op]], ok: op === 'enable' ? 'Re-enable' : op === 'disable' ? 'Disable' : 'Sign out' }))) return;
  await busy(button, async () => {
    try {
      await post('admin', { id: a.id, op });
      if (a.you && op === 'signout') return signedOut();
      toast('Done');
      loadAdmins();
    } catch (err) {
      toast(err.message);
    }
  });
}

$('inviteAdminForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  formError(form, '');
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      const { link } = await post('invite', { email: $('inviteAdminEmail').value, name: $('inviteAdminName').value });
      $('inviteLink').value = link;
      $('inviteOut').hidden = false;
      $('inviteAdminEmail').value = '';
      $('inviteAdminName').value = '';
      loadAdmins();
    } catch (err) {
      formError(form, err.message);
    }
  });
});

$('copyInvite').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('inviteLink').value);
    toast('Copied');
  } catch {
    $('inviteLink').select();
  }
});

$('myRecoveryForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  formError(form, '');
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      const { recoveryCodes } = await post('my-recovery', { code: $('myRecoveryCode').value });
      $('myRecoveryCode').value = '';
      showCodes(recoveryCodes, () => { signedIn(me); openTab('admins'); });
    } catch (err) {
      formError(form, err.message);
    }
  });
});

$('myPasswordForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  formError(form, '');
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      const { admin } = await post('my-password', { password: $('myPassword').value, newPassword: $('myNewPassword').value, code: $('myPasswordCode').value });
      for (const id of ['myPassword', 'myNewPassword', 'myPasswordCode']) $(id).value = '';
      me = admin;
      toast('Password changed. Other sessions were signed out.');
    } catch (err) {
      formError(form, err.message);
    }
  });
});

$('myMfaForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  formError(form, '');
  await busy(form.querySelector('[type=submit]'), async () => {
    try {
      const data = await post('mfa-reset-start', { password: $('myMfaPassword').value });
      $('myMfaPassword').value = '';
      showEnroll(data);
    } catch (err) {
      formError(form, err.message);
    }
  });
});

// ---- Settings ----

const SERVICE_LABELS = {
  stripe: ['Stripe', v => (v ? `connected (${v} mode)` : 'not set up')],
  stripeWebhook: ['Stripe webhook secret', v => (v ? 'set' : 'not set')],
  play: ['Google Play Billing', v => (v ? `set up (${v})` : 'not set up')],
  playNotices: ['Google Play notices (PLAY_RTDN_SECRET)', v => (v ? 'set' : 'not set')],
  email: ['Sign-in email (Resend)', v => (v ? 'set up' : 'not set up')],
  sync: ['Real-time sync relay', v => (v ? 'set up' : 'off (devices check every 2 s)')],
  legacyOwnerEmail: ['OWNER_EMAIL', v => (v ? 'still set but no longer used: you can remove it' : 'not set (not needed)')],
  setupToken: ['ADMIN_SETUP_TOKEN', v => (v ? 'set: no longer needed after the first admin, you can remove it' : 'not set')]
};

async function loadSettings() {
  try {
    const { settings, services } = await get('settings');
    $('signupsOpen').checked = settings.signupsOpen;
    $('services').replaceChildren(...Object.entries(SERVICE_LABELS).map(([k, [label, fmt]]) => {
      const good = k === 'legacyOwnerEmail' || k === 'setupToken' ? !services[k] : Boolean(services[k]);
      return h('li', {}, h('span', { class: `ad-dot ${good ? 'ad-dot-ok' : 'ad-dot-warn'}`, 'aria-hidden': 'true' }), h('span', { text: label }), h('span', { class: 'ad-hint', text: fmt(services[k]) }));
    }));
  } catch (err) {
    $('settingsError').textContent = err.message;
  }
}

$('signupsOpen').addEventListener('change', async e => {
  const box = e.currentTarget;
  $('settingsError').textContent = '';
  box.disabled = true;
  try {
    const { settings } = await post('settings', { signupsOpen: box.checked });
    box.checked = settings.signupsOpen;
    toast(settings.signupsOpen ? 'Sign-ups are open' : 'Sign-ups are paused');
  } catch (err) {
    box.checked = !box.checked;
    $('settingsError').textContent = err.message;
  } finally {
    box.disabled = false;
  }
});

const LOADERS = { overview: loadOverview, accounts: loadAccountsTab, errors: loadErrors, audit: loadAudit, admins: loadAdmins, settings: loadSettings };

start();
