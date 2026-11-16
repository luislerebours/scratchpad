const API_STATE = '/.netlify/functions/state';
const API_FILES = '/.netlify/functions/files';
const API_IMAGES = '/.netlify/functions/images';
const API_AUTH = '/.netlify/functions/auth';
const API_SYNC = '/.netlify/functions/sync';
const API_CHECK = '/api/check';
const SAFETY_CHECK_MS = 60_000;
const OLD_FILE_DAYS = 30;
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const PING_MS = 25_000;
const POLL_MS = 2000;
const SAVE_DELAY_MS = 450;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const PARALLEL_CHUNKS = 3;
const CHUNK_RETRIES = 3;
const LAST_SHEET_KEY = 'scratchpad:lastSheet';
const MAX_PREVIEW_BYTES = 3_900_000;
const PREVIEW_DIM = 2560;
const SHOW_ORIGINAL_UP_TO = 1_500_000;
const DISPLAYABLE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const STORABLE_TYPES = [...DISPLAYABLE_TYPES, 'image/avif', 'image/heic', 'image/heif'];
const MAX_SHEETS = 10;

const pad = document.querySelector('#scratchpad');
const statusEl = document.querySelector('#status');
const saveStatusEl = document.querySelector('#saveStatus');
const saveStatusText = document.querySelector('#saveStatusText');
const retrySaveBtn = document.querySelector('#retrySaveBtn');
const copyBtn = document.querySelector('#copyBtn');
const sheetMenuBtn = document.querySelector('#sheetMenuBtn');
const attachLink = document.querySelector('#attachLink');
const attachText = document.querySelector('#attachText');
const tipsEl = document.querySelector('#tips');
const tabsScroller = document.querySelector('#tabsScroller');
const filesSection = document.querySelector('#filesSection');
const filesHeading = document.querySelector('#filesHeading');
const avatarEl = document.querySelector('#avatar');
const fileInput = document.querySelector('#fileInput');
const fileList = document.querySelector('#fileList');
const transferList = document.querySelector('#transferList');
const storageText = document.querySelector('#storageText');
const oldFilesNote = document.querySelector('#oldFilesNote');
const oldFilesTitle = document.querySelector('#oldFilesTitle');
const oldFilesText = document.querySelector('#oldFilesText');
const filesHint = document.querySelector('#filesHint');
const selectBtn = document.querySelector('#selectBtn');
const uploadBtn = document.querySelector('#uploadBtn');
const selectBar = document.querySelector('#selectBar');
const selectAllBox = document.querySelector('#selectAllBox');
const bulkBar = document.querySelector('#bulkBar');
const bulkCount = document.querySelector('#bulkCount');
const bulkSaveBtn = document.querySelector('#bulkSaveBtn');
const bulkDeleteBtn = document.querySelector('#bulkDeleteBtn');
const sheetModal = document.querySelector('#sheetModal');
const sheetTitle = document.querySelector('#sheetTitle');
const sheetText = document.querySelector('#sheetText');
const sheetItems = document.querySelector('#sheetItems');
const sheetActions = document.querySelector('#sheetActions');
const emptyFiles = document.querySelector('#emptyFiles');
const toastEl = document.querySelector('#toast');
const sheetTabsEl = document.querySelector('#sheetTabs');
const addSheetBtn = document.querySelector('#addSheetBtn');
const accountBtn = document.querySelector('#accountBtn');
const authScreen = document.querySelector('#authScreen');
const adminModal = document.querySelector('#adminModal');
const adminBody = document.querySelector('#adminBody');
const renameModal = document.querySelector('#renameModal');
const renameForm = document.querySelector('#renameForm');
const renameInput = document.querySelector('#renameInput');
const previewModal = document.querySelector('#previewModal');
const previewBody = document.querySelector('#previewBody');
const previewTitle = document.querySelector('#previewTitle');
const previewSaveBtn = document.querySelector('#previewSaveBtn');
const previewRemoveBtn = document.querySelector('#previewRemoveBtn');
const padCard = document.querySelector('.pad-card');
const imageTools = document.querySelector('#imageTools');
const imageFrame = document.querySelector('#imageFrame');
const imageHandle = document.querySelector('#imageHandle');

let activeSheet = 1;
let localUpdatedAt = 0;
let saveTimer = null;
let saving = false;
let lastInputAt = 0;
let lastFileRefresh = 0;
let sheets = [{ id: 1, name: 'Sheet 1' }];
let sheetsSignature = '';
let account = null;
// Last change markers seen; the 2-second check compares against these.
let revs = {};
let checking = false;
let lastCheckAt = 0;
let retryCheckTimer = null;
// Live connection to the relay; while it's healthy the 2-second check is off.
let socket = null;
let socketHealthy = false;
let reconnectDelay = 1000;
let reconnectTimer = null;
let pingTimer = null;
let pongTimer = null;
let previewObjectUrl = null;
let previewFile = null;
let previewLoadedFile = null;
let previewAbort = null;
let fileIndex = new Map();
let currentFiles = [];
let filesSignature = '';
let selecting = false;
let selectedIds = new Set();
let pendingImageUploads = 0;
let viewedImage = null;
let selectedImage = null;
let resizingImage = false;
// Swipe-to-delete on file rows (see "Swipe a file left").
const SWIPE_OPEN = 88;
const UNDO_MS = 5000;
const pendingDeletes = new Map();
let swipe = null;
let openSwipeRow = null;
let swipeClickBlockedUntil = 0;

function validSheet(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SHEETS ? n : (sheets[0]?.id || 1);
}

function hasSheet(id) {
  return sheets.some(s => s.id === id);
}

function currentSheetName(sheet = activeSheet) {
  return sheets.find(s => s.id === Number(sheet))?.name || `Sheet ${sheet}`;
}

// Connection to the server, shown as a quiet dot in the header; words only
// appear when something is wrong.
function setConnection(state) {
  if (statusEl.dataset.state === state) return;
  const wasOffline = statusEl.dataset.state === 'offline';
  statusEl.dataset.state = state;
  // Back online after a failed save: try that save again on its own.
  if (state === 'live' && wasOffline && saveStateName === 'failed') {
    setTimeout(() => {
      if (saveStateName === 'failed' && !saving && !saveTimer) saveState(activeSheet);
    }, 0);
  }
  const label = state === 'live' ? 'Connected' : state === 'offline' ? 'Offline' : 'Connecting…';
  statusEl.title = state === 'live' ? 'Connected: changes sync across your devices' : label;
  statusEl.querySelector('.conn-label').textContent = label;
}

// Save state of the open sheet, shown in the editor toolbar. "Saved" only
// ever follows a confirmed write (or content loaded from the server).
let saveStateName = 'loading';

function setSaveState(state) {
  saveStateName = state;
  renderSaveStatus();
}

function renderSaveStatus() {
  const text = {
    loading: 'Loading…',
    unsaved: 'Unsaved changes',
    saving: 'Saving…',
    failed: 'Couldn’t save'
  }[saveStateName] || (localUpdatedAt ? `Saved · ${formatSavedTime(localUpdatedAt)}` : 'Nothing saved yet');
  saveStatusText.textContent = text;
  saveStatusEl.dataset.state = saveStateName;
  retrySaveBtn.hidden = saveStateName !== 'failed';
  if (localUpdatedAt) saveStatusEl.title = new Date(localUpdatedAt).toLocaleString();
}

function showToast(text, { action, run, duration = 1800 } = {}) {
  const label = document.createElement('span');
  label.textContent = text;
  toastEl.replaceChildren(label);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action;
    btn.addEventListener('click', () => {
      toastEl.classList.remove('show');
      run();
    });
    toastEl.append(btn);
  }
  toastEl.classList.toggle('has-action', Boolean(action));
  toastEl.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

function formatSavedTime(ts) {
  const date = new Date(ts);
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit' }).format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = new Intl.DateTimeFormat(undefined, sameYear ? { month:'short', day:'numeric' } : { month:'short', day:'numeric', year:'numeric' }).format(date);
  return `${day}, ${time}`;
}

// ---- Copies of each sheet kept in memory, so a tab shows its text at once ----
// sheetCache: sheet -> { html, updatedAt } as last saved or fetched.
// filesCache: sheet -> its file list as last fetched.
const sheetCache = new Map();
const filesCache = new Map();
const ownRevs = new Map();
const otherRefreshTimers = new Map();

function cacheSheet(sheet, html, updatedAt) {
  const known = sheetCache.get(sheet);
  if (known && known.updatedAt > updatedAt) return;
  sheetCache.set(sheet, { html, updatedAt });
}

// One request for every sheet's text, made when the app opens.
async function prefetchSheets() {
  try {
    const r = await fetch(`${API_STATE}?meta=all`, { cache:'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    for (const s of data.sheets || []) {
      const html = typeof s.html === 'string' ? s.html : textToHtml(s.text || '');
      cacheSheet(Number(s.id), html, Number(s.updatedAt || 0));
    }
  } catch {
    // Tabs just load the way they did before.
  }
}

// Another device changed a sheet that isn't open here: refresh its copy shortly.
function refreshOtherSheet(sheet, kind) {
  const key = `${kind}-${sheet}`;
  clearTimeout(otherRefreshTimers.get(key));
  otherRefreshTimers.set(key, setTimeout(async () => {
    otherRefreshTimers.delete(key);
    if (sheet === activeSheet || !hasSheet(sheet)) return;
    const cache = kind === 'files' ? filesCache : sheetCache;
    try {
      const r = await fetch(kind === 'files' ? filesUrl(sheet) : stateUrl(sheet), { cache:'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (kind === 'files') filesCache.set(sheet, Array.isArray(data.files) ? data.files : []);
      else cacheSheet(sheet, typeof data.html === 'string' ? data.html : textToHtml(data.text || ''), Number(data.updatedAt || 0));
    } catch {
      // A stale copy is worse than none: that tab will load normally instead.
      cache.delete(sheet);
    }
  }, 1500));
}

function forgetSheet(sheet) {
  sheetCache.delete(sheet);
  filesCache.delete(sheet);
}

function stateUrl(sheet = activeSheet) {
  return `${API_STATE}?sheet=${validSheet(sheet)}`;
}

function sheetsUrl() {
  return `${API_STATE}?meta=sheets`;
}

function currentUrl() {
  return `${API_STATE}?meta=current`;
}

function rememberedSheet() {
  try {
    const sheet = Number(localStorage.getItem(LAST_SHEET_KEY));
    return hasSheet(sheet) ? sheet : null;
  } catch {
    return null;
  }
}

async function fetchCurrentSheet() {
  try {
    const r = await fetch(currentUrl(), { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const sheet = Number((await r.json()).sheet);
    return hasSheet(sheet) ? sheet : null;
  } catch {
    return null;
  }
}

// Records the open sheet on this device and on the server for other devices.
function rememberCurrentSheet(sheet) {
  try {
    localStorage.setItem(LAST_SHEET_KEY, String(sheet));
  } catch {
    // Private browsing can block storage; the server copy still works.
  }
  fetch(currentUrl(), {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify({ sheet })
  }).catch(() => {});
}

function filesUrl(sheet = activeSheet, extra = '') {
  const joiner = extra ? '&' : '';
  return `${API_FILES}?sheet=${validSheet(sheet)}${joiner}${extra}`;
}

// ---- Icons ----

const ICON_PATHS = {
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  eraser: '<path d="M20 20H9l-4.5-4.5a2 2 0 0 1 0-2.8L13 4.2a2 2 0 0 1 2.8 0l4 4a2 2 0 0 1 0 2.8L12 19"/><path d="m8 10 6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  pin: '<path d="M12 17v4M8 3h8l-1 6 3 3v2H6v-2l3-3-1-6Z"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  landscape: '<path d="M2.5 19 8.5 11l4.5 5.5 3-3.5 5.5 6z" fill="currentColor" stroke="none"/><circle cx="16.5" cy="7.5" r="2.2" fill="currentColor" stroke="none"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5L5 20"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h12"/>',
  devices: '<rect x="3" y="4" width="13" height="10" rx="1.5"/><path d="M7 18h5M17 9h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"/>'
};

const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

// ---- Returning focus after a dialog closes ----

let returnFocusTo = null;

function rememberFocus() {
  const el = document.activeElement;
  if (el && el !== document.body) returnFocusTo = el;
}

function restoreFocus() {
  const el = returnFocusTo;
  returnFocusTo = null;
  if (el?.isConnected) el.focus({ preventScroll:true });
}

// ---- Menus (sheet, file and account actions) ----
// items: { label, icon, danger, run } | 'separator' | { heading } | null (skipped)

let openMenuState = null;

function closeMenu({ focusTrigger = true } = {}) {
  if (!openMenuState) return;
  const { el, trigger } = openMenuState;
  openMenuState = null;
  el.remove();
  trigger.setAttribute('aria-expanded', 'false');
  if (!focusTrigger) return;
  // The file list may have been redrawn while the menu was open: find the new button.
  const target = trigger.isConnected ? trigger
    : trigger.dataset.fileMenu ? fileList.querySelector(`[data-file-menu="${CSS.escape(trigger.dataset.fileMenu)}"]`) : null;
  target?.focus({ preventScroll:true });
}

function openMenu(trigger, items, label) {
  const toggling = openMenuState?.trigger === trigger;
  closeMenu({ focusTrigger:false });
  if (toggling) return;

  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  if (label) el.setAttribute('aria-label', label);
  for (const item of items) {
    if (!item) continue;
    if (item === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      sep.setAttribute('role', 'separator');
      el.append(sep);
    } else if (item.heading) {
      const heading = document.createElement('div');
      heading.className = 'menu-heading';
      heading.textContent = item.heading;
      el.append(heading);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `menu-item${item.danger ? ' danger' : ''}`;
      btn.setAttribute('role', 'menuitem');
      btn.tabIndex = -1;
      btn.innerHTML = item.icon ? icon(item.icon) : '';
      const text = document.createElement('span');
      text.textContent = item.label;
      btn.append(text);
      btn.addEventListener('click', () => {
        closeMenu();
        item.run();
      });
      el.append(btn);
    }
  }
  document.body.append(el);
  trigger.setAttribute('aria-expanded', 'true');

  // Below the button, right-aligned; flipped above or nudged in near screen edges.
  // Returns false once the button has scrolled out of sight.
  const place = () => {
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.visualViewport?.height || window.innerHeight;
    if (r.bottom < 0 || r.top > vh || !trigger.isConnected) return false;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, vw - w - 8));
    let top = r.bottom + 6;
    if (top + h > vh - 8) top = r.top - h - 6 >= 8 ? r.top - h - 6 : Math.max(8, vh - h - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    return true;
  };
  openMenuState = { el, trigger, place, width: window.innerWidth };
  place();

  const entries = () => [...el.querySelectorAll('[role="menuitem"]')];
  entries()[0]?.focus({ preventScroll:true });
  el.addEventListener('keydown', e => {
    const list = entries();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      list[(i + step + list.length) % list.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
    }
  });
}

document.addEventListener('pointerdown', e => {
  if (openMenuState && !openMenuState.el.contains(e.target) && !openMenuState.trigger.contains(e.target)) {
    closeMenu({ focusTrigger:false });
  }
});
// Scrolling carries the menu along with its button; it closes once the button is out of sight.
document.addEventListener('scroll', e => {
  if (openMenuState && !openMenuState.el.contains(e.target) && !openMenuState.place()) closeMenu({ focusTrigger:false });
}, true);
window.addEventListener('resize', () => {
  // Phones resize when browser bars move; only a real width change closes the menu.
  if (openMenuState && openMenuState.width !== window.innerWidth) closeMenu({ focusTrigger:false });
});

// Tips: close on Escape or a tap elsewhere.
document.addEventListener('pointerdown', e => {
  if (tipsEl.open && !tipsEl.contains(e.target)) tipsEl.open = false;
});
tipsEl.addEventListener('keydown', e => {
  if (e.key === 'Escape' && tipsEl.open) {
    e.stopPropagation();
    tipsEl.open = false;
    tipsEl.querySelector('summary').focus();
  }
});

// ---- Sheet tabs: built from the account's sheet list ----

function renderTabs() {
  sheetTabsEl.replaceChildren(...sheets.map(sheet => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `sheet-tab${sheet.id === activeSheet ? ' active' : ''}`;
    tab.dataset.sheet = String(sheet.id);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(sheet.id === activeSheet));
    // One stop in the Tab order; arrow keys move between tabs, Enter opens one.
    tab.tabIndex = sheet.id === activeSheet ? 0 : -1;
    tab.title = sheet.name;
    const label = document.createElement('span');
    label.className = 'sheet-label';
    label.textContent = sheet.name;
    tab.append(label);
    return tab;
  }));
  addSheetBtn.hidden = sheets.length >= MAX_SHEETS;
  updateFilesSubtitle();
  requestAnimationFrame(() => revealActiveTab());
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Keeps the open tab fully in view, and fades the edges that hide more tabs.
function revealActiveTab(smooth = false) {
  const tab = sheetTabsEl.querySelector('.sheet-tab.active');
  if (tab) {
    const pad = 28;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    const view = tabsScroller.clientWidth;
    let target = null;
    if (left - pad < tabsScroller.scrollLeft) target = Math.max(0, left - pad);
    else if (right + pad > tabsScroller.scrollLeft + view) target = right + pad - view;
    if (target !== null) tabsScroller.scrollTo({ left: target, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
  }
  updateTabFades();
}

function updateTabFades() {
  const max = tabsScroller.scrollWidth - tabsScroller.clientWidth;
  tabsScroller.classList.toggle('fade-start', tabsScroller.scrollLeft > 2);
  tabsScroller.classList.toggle('fade-end', tabsScroller.scrollLeft < max - 2);
}

tabsScroller.addEventListener('scroll', updateTabFades, { passive:true });
window.addEventListener('resize', () => revealActiveTab());

// Arrow keys move between tabs.
sheetTabsEl.addEventListener('keydown', e => {
  const tabs = [...sheetTabsEl.querySelectorAll('.sheet-tab')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  const tab = tabs[(next + tabs.length) % tabs.length];
  tab.focus();
  tab.scrollIntoView({ block:'nearest', inline:'nearest' });
});

function applySheets(data) {
  if (!Array.isArray(data?.sheets) || !data.sheets.length) return;
  const signature = JSON.stringify(data.sheets);
  if (signature === sheetsSignature) return;
  sheetsSignature = signature;
  sheets = data.sheets.map(s => ({ id: Number(s.id), name: String(s.name || `Sheet ${s.id}`) }));
  for (const id of [...sheetCache.keys(), ...filesCache.keys()]) if (!hasSheet(id)) forgetSheet(id);
  renderTabs();
  // The open sheet was deleted on another device.
  if (!hasSheet(activeSheet)) switchSheet(sheets[0].id, { remember:false, force:true });
}

async function fetchSheets() {
  try {
    const r = await fetch(sheetsUrl(), { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    applySheets(await r.json());
    return true;
  } catch {
    // Keep the tabs we have if the list is briefly unavailable.
    return false;
  }
}

async function postSheets(body) {
  const r = await fetch(sheetsUrl(), {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  applySheets(data);
  return data;
}

async function fetchState(sheet = activeSheet) {
  const requestedSheet = validSheet(sheet);
  try {
    const r = await fetch(stateUrl(requestedSheet), { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    if (requestedSheet !== activeSheet) return false;

    const remoteTs = Number(data.updatedAt || 0);
    const recentlyTyping = Date.now() - lastInputAt < 850;

    const busy = saving || recentlyTyping || resizingImage || pendingImageUploads > 0;
    const remoteHtml = typeof data.html === 'string' ? data.html : textToHtml(data.text || '');
    cacheSheet(requestedSheet, remoteHtml, remoteTs);

    if (remoteTs > localUpdatedAt && !busy) {
      renderEditor(remoteHtml);
      localUpdatedAt = remoteTs;
      if (saveStateName === 'failed') saveStateName = 'saved';
    } else if (!localUpdatedAt && !busy && !saveTimer) {
      renderEditor(remoteHtml);
      localUpdatedAt = remoteTs;
    } else if (remoteTs > localUpdatedAt) {
      // Mid-edit: not applied yet, so the next check fetches it again.
      return false;
    }
    setConnection('live');
    // What's on screen now matches the server.
    if (!saveTimer && !saving && saveStateName !== 'failed') setSaveState('saved');
    return true;
  } catch (err) {
    if (requestedSheet === activeSheet) setConnection('offline');
    return false;
  }
}

async function saveState(sheet = activeSheet) {
  const targetSheet = validSheet(sheet);
  const textToSave = pad.innerText;
  const htmlToSave = serializeEditor();
  saving = true;
  if (targetSheet === activeSheet) setSaveState('saving');
  try {
    const r = await fetch(stateUrl(targetSheet), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: textToSave, html: htmlToSave })
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    cacheSheet(targetSheet, htmlToSave, Number(data.updatedAt || Date.now()));
    if (data.rev) ownRevs.set(`text-${targetSheet}`, data.rev);
    if (targetSheet === activeSheet) {
      // Our own save: no need to fetch it back on the next check.
      if (data.rev && !saveTimer) revs.text = data.rev;
      localUpdatedAt = Number(data.updatedAt || Date.now());
      setConnection('live');
      // Typed again while this save was in flight: still unsaved.
      setSaveState(saveTimer ? 'unsaved' : 'saved');
    }
  } catch (err) {
    if (targetSheet === activeSheet && !saveTimer) setSaveState('failed');
  } finally {
    saving = false;
  }
}

retrySaveBtn.addEventListener('click', () => saveState(activeSheet));

// Called after anything changes the editor's content.
function onEditorChanged() {
  lastInputAt = Date.now();
  updateEmptyState();
  clearTimeout(saveTimer);
  setSaveState('unsaved');
  const sheetAtInput = activeSheet;
  saveTimer = setTimeout(() => { saveTimer = null; saveState(sheetAtInput); }, SAVE_DELAY_MS);
}

pad.addEventListener('input', onEditorChanged);

// Text and images only: block bold/italic and other formatting shortcuts.
pad.addEventListener('beforeinput', e => {
  if (e.inputType.startsWith('format')) e.preventDefault();
});

copyBtn.addEventListener('click', async () => {
  const text = pad.innerText;
  const html = serializeEditor().replace(/src="\//g, `src="${location.origin}/`);
  try {
    if (!window.ClipboardItem || !navigator.clipboard.write) throw new Error('No rich clipboard');
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type:'text/html' }),
      'text/plain': new Blob([text], { type:'text/plain' })
    })]);
  } catch {
    await navigator.clipboard.writeText(text);
  }
  showToast('Copied');
});

// Clearing empties the text and images; the sheet and its files stay.
function confirmClearSheet() {
  const name = currentSheetName();
  if (editorIsEmpty()) {
    showToast(`${name} is already empty`);
    return;
  }
  openSheet({
    title: `Clear the text in ${name}?`,
    text: 'This removes all text and images in the editor, on all your devices. The sheet and its files stay.',
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: 'Clear text',
        kind: 'danger-solid',
        run: () => {
          pad.replaceChildren();
          onEditorChanged();
          showToast(`Cleared ${name}`);
        }
      }
    ]
  });
}

sheetMenuBtn.addEventListener('click', () => {
  openMenu(sheetMenuBtn, [
    { label: 'Rename sheet', icon: 'pencil', run: openRenameModal },
    'separator',
    { label: 'Clear sheet text…', icon: 'eraser', run: confirmClearSheet },
    sheets.length > 1 ? { label: 'Delete sheet…', icon: 'trash', danger: true, run: confirmDeleteSheet } : null
  ], 'Sheet actions');
});

// ---- Editor content: text plus this site's own images ----

const PAD_IMAGE_SRC = /^\/\.netlify\/functions\/images\?sheet=(?:[1-9]|10)&id=[A-Za-z0-9-]{1,64}$/;
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TR', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);
const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'SVG', 'MATH', 'HEAD', 'TITLE', 'META', 'LINK', 'VIDEO', 'AUDIO', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

function textToHtml(text) {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function makePadImage(src, width = null) {
  const img = document.createElement('img');
  img.setAttribute('src', src);
  img.className = 'pad-image';
  img.alt = 'Pasted image';
  setImageWidth(img, width);
  return img;
}

// Width is a percentage of the text column, so it looks the same on every device.
function clampWidth(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(10, n)) : null;
}

function setImageWidth(img, width) {
  width = clampWidth(width);
  if (width) {
    img.dataset.width = String(width);
    img.style.width = `${width}%`;
    img.style.maxHeight = 'none';
  } else {
    delete img.dataset.width;
    img.style.width = '';
    img.style.maxHeight = '';
  }
}

// Copies only text, line breaks and this site's images from `source` into
// `target`. Anyone with the link can edit, so stored html is never trusted:
// it is rebuilt through this before it is shown or saved. `onOtherImage`
// may return a stand-in element for any other image (used when pasting).
function appendClean(source, target, onOtherImage) {
  for (const node of [...source.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(node.textContent);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName.toUpperCase();
    if (DROPPED_TAGS.has(tag)) continue;
    if (tag === 'BR') {
      target.append(document.createElement('br'));
    } else if (tag === 'IMG') {
      const src = node.getAttribute('src') || '';
      const img = PAD_IMAGE_SRC.test(src) ? makePadImage(src, node.getAttribute('data-width')) : onOtherImage?.(src);
      if (img) target.append(img);
    } else if (BLOCK_TAGS.has(tag)) {
      const div = document.createElement('div');
      appendClean(node, div, onOtherImage);
      target.append(div);
    } else {
      appendClean(node, target, onOtherImage);
    }
  }
}

function cleanHtml(html, onOtherImage) {
  // DOMParser documents are inert: nothing in them runs or loads.
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  const out = document.createElement('div');
  appendClean(doc.body, out, onOtherImage);
  return out;
}

// The editor as html to store; images still uploading are left out.
function serializeEditor() {
  const out = document.createElement('div');
  appendClean(pad, out);
  return out.innerHTML;
}

function editorIsEmpty() {
  return !pad.querySelector('img') && !pad.textContent.trim();
}

function updateEmptyState() {
  pad.classList.toggle('is-empty', editorIsEmpty());
}

function caretOffset() {
  const sel = getSelection();
  if (!sel.rangeCount || !pad.contains(sel.focusNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(pad);
  range.setEnd(sel.focusNode, sel.focusOffset);
  return range.toString().length;
}

function placeCaret(offset) {
  const range = document.createRange();
  const walker = document.createTreeWalker(pad, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node;
  let placed = false;
  while ((node = walker.nextNode())) {
    if (remaining <= node.length) {
      range.setStart(node, remaining);
      placed = true;
      break;
    }
    remaining -= node.length;
  }
  if (!placed) {
    range.selectNodeContents(pad);
    range.collapse(false);
  }
  range.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function renderEditor(html) {
  const clean = cleanHtml(html);
  if (clean.innerHTML === serializeEditor()) return;
  const caret = document.activeElement === pad ? caretOffset() : null;
  pad.replaceChildren(...clean.childNodes);
  if (caret !== null) placeCaret(caret);
  updateEmptyState();
  positionImageTools();
}

function insertAtCaret(nodes) {
  const sel = getSelection();
  let range = sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!range || !pad.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(pad);
    range.collapse(false);
  }
  range.deleteContents();
  const fragment = document.createDocumentFragment();
  fragment.append(...nodes);
  const last = fragment.lastChild;
  range.insertNode(fragment);
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  onEditorChanged();
}

// ---- Images in the text ----

function loadBitmap(blob) {
  if (window.createImageBitmap) return createImageBitmap(blob).catch(() => loadImageElement(blob));
  return loadImageElement(blob);
}

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Unreadable image')); };
    img.src = url;
  });
}

function imageTypeOf(blob) {
  if (blob.type) return blob.type.toLowerCase();
  const name = blob.name || '';
  if (/\.heic$/i.test(name)) return 'image/heic';
  if (/\.heif$/i.test(name)) return 'image/heif';
  return '';
}

// A smaller JPEG for showing in the text; the original is kept as well.
// Throws when this browser can't read the image (HEIC outside Safari, say).
async function makeDisplayCopy(blob) {
  const source = await loadBitmap(blob);
  const width = source.width;
  const height = source.height;
  let scale = Math.min(1, PREVIEW_DIM / Math.max(width, height));
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (out && out.size <= MAX_PREVIEW_BYTES) return out;
    scale *= 0.75;
  }
  throw new Error('Image too large');
}

function imageUrl(sheet, extra) {
  return `${API_IMAGES}?sheet=${validSheet(sheet)}&${extra}`;
}

// Uploads the image behind a placeholder <img>, then points it at the server copy.
async function uploadPadImage(img, blob) {
  pendingImageUploads++;
  const sheet = activeSheet;
  const localUrl = img.getAttribute('src');
  let type = imageTypeOf(blob);
  const name = blob.name || 'Pasted image';
  let transfer = null;
  try {
    if (blob.size > MAX_FILE_BYTES) throw new Error(`${name} is over ${bytes(MAX_FILE_BYTES)}`);
    const needsCopy = !DISPLAYABLE_TYPES.includes(type) || blob.size > SHOW_ORIGINAL_UP_TO;
    transfer = createTransfer(name, 'Uploading', blob.size);
    let preview = null;
    if (needsCopy) {
      transfer.status('Preparing…');
      try {
        preview = await makeDisplayCopy(blob);
      } catch {
        // Can't be shown in this browser: keep it as a file instead.
        transfer.done('Added to Files instead');
        img.remove();
        showToast('This image can’t be shown here, so it was added to Files');
        uploadFiles([blob instanceof File ? blob : new File([blob], name, { type })]);
        return;
      }
    }
    if (!STORABLE_TYPES.includes(type)) {
      // An unusual format (SVG from a web page, say): keep the JPEG copy only.
      blob = preview;
      type = preview.type;
      preview = null;
    }

    const start = await postJson(imageUrl(sheet, 'action=start'), { type, size: blob.size });
    const id = encodeURIComponent(start.id);
    const loaded = new Array(start.chunks).fill(0);
    const report = () => transfer.update(loaded.reduce((a, b) => a + b, 0));
    if (preview) {
      await withRetry(() => putChunk(imageUrl(sheet, `id=${id}&preview=1`), preview, transfer.signal, () => {}, preview.type), transfer.signal);
    }
    await runPool(start.chunks, PARALLEL_CHUNKS, async i => {
      const part = blob.slice(i * start.chunkSize, Math.min(blob.size, (i + 1) * start.chunkSize));
      await withRetry(() => {
        loaded[i] = 0;
        return putChunk(imageUrl(sheet, `id=${id}&chunk=${i}`), part, transfer.signal, n => {
          loaded[i] = n;
          report();
        });
      }, transfer.signal);
    });
    const { src } = await postJson(imageUrl(sheet, `id=${id}&action=finish`));
    img.setAttribute('src', src);
    delete img.dataset.pending;
    img.classList.remove('pending');
    transfer.done(`Image added · ${bytes(blob.size)}`);
    loadUsage();
  } catch (err) {
    img.remove();
    if (transfer) transfer.fail(err?.name === 'AbortError' ? 'Upload cancelled' : err?.quota ? err.message : 'Image upload failed');
    else showToast(err?.message?.includes('over') ? err.message : 'Image upload failed');
  } finally {
    if (localUrl.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(localUrl), 10000);
    pendingImageUploads--;
    if (sheet === activeSheet) onEditorChanged();
  }
}

function pendingImage(src) {
  const img = makePadImage(src);
  img.dataset.pending = '1';
  img.classList.add('pending');
  return img;
}

function insertImageFiles(files) {
  const imgs = files.map(file => pendingImage(URL.createObjectURL(file)));
  insertAtCaret(imgs);
  imgs.forEach((img, i) => uploadPadImage(img, files[i]));
}

// An image pasted as a link (from a web page, say): copy it here if the
// browser is allowed to read it, otherwise drop it.
async function importLinkedImage(img, src) {
  try {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    if (!blob.type.startsWith('image/')) throw new Error('Not an image');
    await uploadPadImage(img, blob);
  } catch {
    img.remove();
    onEditorChanged();
  }
}

function sortFiles(fileList) {
  const files = [...(fileList || [])];
  return {
    images: files.filter(f => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)),
    others: files.filter(f => !(f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)))
  };
}

pad.addEventListener('paste', e => {
  const data = e.clipboardData;
  if (!data) return;
  const { images, others } = sortFiles(data.files);
  if (images.length || others.length) {
    e.preventDefault();
    if (others.length) uploadFiles(others);
    if (images.length) insertImageFiles(images);
    return;
  }

  const html = data.getData('text/html');
  if (html && /<img/i.test(html)) {
    e.preventDefault();
    const imports = [];
    const clean = cleanHtml(html, src => {
      if (!/^(https?:|data:image\/|blob:)/i.test(src)) return null;
      const img = pendingImage(src);
      imports.push([img, src]);
      return img;
    });
    insertAtCaret([...clean.childNodes]);
    imports.forEach(([img, src]) => importLinkedImage(img, src));
    return;
  }

  // Everything else goes in as plain text, without outside formatting.
  e.preventDefault();
  const text = data.getData('text/plain');
  if (text && !document.execCommand('insertText', false, text)) {
    insertAtCaret(text.split('\n').flatMap((line, i) => (i ? [document.createElement('br'), line] : [line])));
  }
});

pad.addEventListener('dragover', e => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
});

pad.addEventListener('drop', e => {
  const { images, others } = sortFiles(e.dataTransfer?.files);
  if (!images.length && !others.length) return;
  e.preventDefault();
  const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  const pos = !range && document.caretPositionFromPoint?.(e.clientX, e.clientY);
  if (range || pos) {
    const r = range || document.createRange();
    if (pos) r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }
  if (others.length) uploadFiles(others);
  if (images.length) insertImageFiles(images);
});

// ---- Selecting and resizing an image in the text ----

try { document.execCommand('enableObjectResizing', false, false); } catch { /* Firefox only */ }

function selectImage(img) {
  if (selectedImage !== img) selectedImage?.classList.remove('selected');
  selectedImage = img;
  img.classList.add('selected');
  imageTools.hidden = false;
  imageFrame.hidden = false;
  positionImageTools();
}

function deselectImage() {
  selectedImage?.classList.remove('selected');
  selectedImage = null;
  imageTools.hidden = true;
  imageFrame.hidden = true;
}

function positionImageTools() {
  if (!selectedImage) return;
  if (!selectedImage.isConnected || !pad.contains(selectedImage)) {
    deselectImage();
    return;
  }
  const card = padCard.getBoundingClientRect();
  const r = selectedImage.getBoundingClientRect();
  Object.assign(imageFrame.style, {
    left: `${r.left - card.left}px`,
    top: `${r.top - card.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`
  });
  const barW = imageTools.offsetWidth;
  const barH = imageTools.offsetHeight;
  let top = r.bottom - card.top + 10;
  if (top + barH > card.height - 6) top = r.top - card.top - barH - 10;
  if (top < 6) top = r.top - card.top + 10;
  const left = Math.min(Math.max(8, r.left - card.left), card.width - barW - 8);
  imageTools.style.top = `${top}px`;
  imageTools.style.left = `${Math.max(8, left)}px`;
  const width = Number(selectedImage.dataset.width || 0);
  imageTools.querySelectorAll('[data-size]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.size) === width);
  });
}

pad.addEventListener('click', e => {
  const img = e.target.closest('img.pad-image');
  if (img && !img.dataset.pending) selectImage(img);
  else deselectImage();
});

document.addEventListener('pointerdown', e => {
  if (selectedImage && !e.target.closest('#imageTools, #imageFrame, img.pad-image')) deselectImage();
});

pad.addEventListener('keydown', e => {
  if (!selectedImage) return;
  if (e.key === 'Escape') deselectImage();
  else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    const img = selectedImage;
    deselectImage();
    img.remove();
    onEditorChanged();
  } else if (e.key.length === 1 || e.key === 'Enter') {
    deselectImage();
  }
});

pad.addEventListener('input', positionImageTools);
window.addEventListener('resize', positionImageTools);
new ResizeObserver(positionImageTools).observe(pad);

imageTools.addEventListener('click', e => {
  const img = selectedImage;
  if (!img) return;
  const sizeBtn = e.target.closest('[data-size]');
  if (sizeBtn) {
    setImageWidth(img, Number(sizeBtn.dataset.size));
    onEditorChanged();
    positionImageTools();
    return;
  }
  const tool = e.target.closest('[data-tool]')?.dataset.tool;
  if (tool === 'view') {
    deselectImage();
    openImageViewer(img);
  } else if (tool === 'remove') {
    deselectImage();
    img.remove();
    onEditorChanged();
  }
});

// Drag the corner handle to any width.
imageHandle.addEventListener('pointerdown', e => {
  const img = selectedImage;
  if (!img) return;
  e.preventDefault();
  e.stopPropagation();
  imageHandle.setPointerCapture(e.pointerId);
  const styles = getComputedStyle(img.parentElement === pad ? pad : img.parentElement);
  const column = (img.parentElement === pad ? pad : img.parentElement).clientWidth
    - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
  const startX = e.clientX;
  const startWidth = img.getBoundingClientRect().width;
  resizingImage = true;

  const move = ev => {
    const width = ((startWidth + ev.clientX - startX) / column) * 100;
    setImageWidth(img, width);
    lastInputAt = Date.now();
    positionImageTools();
  };
  const end = () => {
    imageHandle.removeEventListener('pointermove', move);
    imageHandle.removeEventListener('pointerup', end);
    imageHandle.removeEventListener('pointercancel', end);
    resizingImage = false;
    onEditorChanged();
  };
  imageHandle.addEventListener('pointermove', move);
  imageHandle.addEventListener('pointerup', end);
  imageHandle.addEventListener('pointercancel', end);
});

async function switchSheet(nextSheet, { remember = true, force = false } = {}) {
  nextSheet = validSheet(nextSheet);
  if (nextSheet === activeSheet && !force) return;
  if (!hasSheet(nextSheet)) return;
  if (pendingImageUploads) {
    showToast('Wait for images to finish uploading');
    return;
  }

  // Edits not yet saved would be lost by switching: save them first, and stay
  // on this sheet if that fails.
  if ((saveTimer || saveStateName === 'failed') && hasSheet(activeSheet)) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveState(activeSheet);
    if (saveStateName === 'failed' && !force) {
      showToast('Couldn’t save this sheet. Check your connection and try again.');
      return;
    }
  }
  if (remember) rememberCurrentSheet(nextSheet);

  pad.contentEditable = 'false';
  activeSheet = nextSheet;
  revs = { sheets: revs.sheets };
  lastInputAt = 0;
  lastFileRefresh = 0;
  deselectImage();
  setSelecting(false);

  // Show the sheet as last saved or fetched right away; the fetch below
  // brings in anything newer. Without a copy, show a blank page (not the
  // "type here" hint) until it arrives.
  const cached = sheetCache.get(nextSheet);
  localUpdatedAt = cached ? cached.updatedAt : 0;
  if (cached) renderEditor(cached.html);
  else pad.replaceChildren();
  pad.classList.toggle('is-loading', !cached);
  updateEmptyState();
  showCachedFiles(nextSheet);
  updateFilesSubtitle();

  renderTabs();
  revealActiveTab(true);

  setSaveState(cached ? 'saved' : 'loading');
  let [loaded] = await Promise.all([fetchState(nextSheet), loadFiles(true, nextSheet)]);
  // Not loaded and nothing to show: wait for the connection rather than offer
  // an empty page whose first keystroke would replace the saved text.
  for (let delay = 1000; !loaded && !cached && nextSheet === activeSheet; delay = Math.min(delay * 2, 8000)) {
    await new Promise(resolve => setTimeout(resolve, delay));
    if (nextSheet === activeSheet) loaded = await fetchState(nextSheet);
  }
  if (nextSheet !== activeSheet) return;
  pad.classList.remove('is-loading');
  pad.contentEditable = 'true';
}

// The file list as last seen, or nothing (rather than "No files") until it loads.
function showCachedFiles(sheet) {
  const files = filesCache.get(sheet);
  filesSignature = files ? JSON.stringify(files) : '';
  currentFiles = (files || []).filter(f => !pendingDeletes.has(f.id)).map(f => ({ ...f, sheet }));
  fileIndex = new Map(currentFiles.map(f => [f.id, f]));
  if (files) {
    renderFiles();
    return;
  }
  fileList.innerHTML = '';
  emptyFiles.hidden = true;
  selectBtn.hidden = true;
  updateOldFilesNote();
  updateAttachLink();
}

sheetTabsEl.addEventListener('click', e => {
  const tab = e.target.closest('.sheet-tab');
  if (tab) switchSheet(Number(tab.dataset.sheet));
});

sheetTabsEl.addEventListener('dblclick', e => {
  const tab = e.target.closest('.sheet-tab');
  if (!tab) return;
  e.preventDefault();
  const sheet = Number(tab.dataset.sheet);
  if (sheet !== activeSheet) switchSheet(sheet).then(openRenameModal);
  else openRenameModal();
});

addSheetBtn.addEventListener('click', async () => {
  addSheetBtn.disabled = true;
  try {
    const data = await postSheets({ action:'add' });
    // A new sheet starts empty: no need to wait for it.
    forgetSheet(data.added);
    cacheSheet(data.added, '', 0);
    filesCache.set(data.added, []);
    await switchSheet(data.added);
    openRenameModal();
  } catch (err) {
    showToast(err.message || 'Could not add a sheet');
  } finally {
    addSheetBtn.disabled = false;
  }
});

// From the sheet menu (••• in the editor toolbar).
function confirmDeleteSheet() {
  const sheet = activeSheet;
  const name = currentSheetName(sheet);
  closeRenameModal();
  if (sheets.length === 1) {
    showToast('You need at least one sheet');
    return;
  }
  openSheet({
    title: `Delete ${name}?`,
    text: 'Its text, images and files are deleted on all your devices. This can’t be undone.',
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: 'Delete sheet',
        kind: 'danger-solid',
        run: async () => {
          clearTimeout(saveTimer);
          saveTimer = null;
          try {
            await postSheets({ action:'delete', sheet });
            forgetSheet(sheet);
            showToast(`Deleted ${name}`);
          } catch (err) {
            showToast(err.message || 'Delete failed');
          }
        }
      }
    ]
  });
}

function openRenameModal() {
  rememberFocus();
  renameInput.value = currentSheetName();
  renameModal.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    renameInput.focus();
    renameInput.select();
  });
}

function closeRenameModal() {
  if (renameModal.hidden) return;
  renameModal.hidden = true;
  if (previewModal.hidden) document.body.classList.remove('modal-open');
  restoreFocus();
}

renameModal.querySelectorAll('[data-close-rename]').forEach(btn => btn.addEventListener('click', closeRenameModal));
renameModal.addEventListener('click', e => { if (e.target === renameModal) closeRenameModal(); });

renameForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name = renameInput.value.replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);
  if (!name) {
    renameInput.focus();
    return;
  }
  try {
    await postSheets({ action:'rename', sheet:activeSheet, name });
    closeRenameModal();
    showToast('Sheet renamed');
  } catch {
    showToast('Rename failed');
  }
});


function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(1).replace(/\.0$/, '')} GB`;
}

function escapeHtml(s='') {
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function abortError() {
  return new DOMException('Cancelled', 'AbortError');
}

// Runs `count` jobs, at most `limit` at a time, stopping on the first failure.
async function runPool(count, limit, job) {
  let next = 0;
  const worker = async () => {
    while (next < count) await job(next++);
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
}

async function withRetry(fn, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' || attempt >= CHUNK_RETRIES) throw err;
      await new Promise(resolve => setTimeout(resolve, 600 * attempt));
    }
  }
}

// ---- Transfer progress rows ----

function createTransfer(name, verb, total, items = null) {
  const row = document.createElement('div');
  row.className = 'transfer-row';
  row.innerHTML = `
    <div class="transfer-top">
      <span class="transfer-name"></span>
      <button class="transfer-cancel" type="button" aria-label="Cancel">Cancel</button>
    </div>
    <div class="transfer-bar"><div class="transfer-fill"></div></div>
    <div class="transfer-meta"></div>`;
  row.querySelector('.transfer-name').textContent = name;
  const itemEls = (items || []).map(itemName => {
    const el = document.createElement('div');
    el.className = 'transfer-item';
    el.innerHTML = '<span></span><span>Waiting</span>';
    el.firstChild.textContent = itemName;
    return el;
  });
  if (itemEls.length) {
    const list = document.createElement('div');
    list.className = 'transfer-items';
    list.append(...itemEls);
    row.append(list);
  }
  const fill = row.querySelector('.transfer-fill');
  const meta = row.querySelector('.transfer-meta');
  const cancelBtn = row.querySelector('.transfer-cancel');
  const controller = new AbortController();
  const startedAt = Date.now();
  cancelBtn.addEventListener('click', () => controller.abort());
  transferList.prepend(row);
  meta.textContent = `Waiting… · ${bytes(total)}`;

  const finish = (state, text) => {
    row.classList.add(state);
    cancelBtn.remove();
    meta.textContent = text;
    setTimeout(() => row.remove(), state === 'done' ? 2500 : 6000);
  };

  return {
    signal: controller.signal,
    update(loaded) {
      const pct = total ? Math.min(100, Math.floor((loaded / total) * 100)) : 100;
      const seconds = (Date.now() - startedAt) / 1000;
      const speed = seconds > 0.5 ? ` · ${bytes(Math.round(loaded / seconds))}/s` : '';
      fill.style.width = `${pct}%`;
      meta.textContent = `${verb} · ${bytes(loaded)} of ${bytes(total)} · ${pct}%${speed}`;
    },
    status(text) {
      meta.textContent = text;
    },
    item(index, text, state) {
      const el = itemEls[index];
      if (!el) return;
      el.lastChild.textContent = text;
      el.classList.toggle('done', state === 'done');
    },
    // Keeps the row with a button, for steps that need a fresh tap (iOS share).
    ready(text, label, onClick) {
      fill.style.width = '100%';
      row.classList.add('ready');
      cancelBtn.remove();
      meta.textContent = text;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn compact transfer-ready';
      btn.textContent = label;
      btn.addEventListener('click', async () => {
        if (await onClick()) row.remove();
      });
      row.querySelector('.transfer-top').append(btn);
    },
    done(text) {
      fill.style.width = '100%';
      finish('done', text);
    },
    // With retry, the row stays (with Retry and Dismiss) until one is chosen.
    fail(text, retry) {
      if (!retry) {
        finish('failed', text);
        return;
      }
      row.classList.add('failed');
      cancelBtn.remove();
      meta.textContent = text;
      const buttons = document.createElement('div');
      buttons.className = 'transfer-buttons';
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'transfer-cancel transfer-retry';
      again.textContent = 'Retry';
      again.addEventListener('click', () => {
        row.remove();
        retry();
      });
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'transfer-cancel';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => row.remove());
      buttons.append(again, dismiss);
      row.querySelector('.transfer-top').append(buttons);
    }
  };
}

// ---- File list ----

async function loadFiles(force = false, sheet = activeSheet) {
  const requestedSheet = validSheet(sheet);
  if (!force && requestedSheet === activeSheet && Date.now() - lastFileRefresh < 1800) return true;
  try {
    const r = await fetch(filesUrl(requestedSheet), { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const files = Array.isArray(data.files) ? data.files : [];
    filesCache.set(requestedSheet, files);
    if (requestedSheet !== activeSheet) return false;

    lastFileRefresh = Date.now();
    const signature = JSON.stringify(files);
    if (signature === filesSignature) return true;
    filesSignature = signature;
    currentFiles = files.filter(f => !pendingDeletes.has(f.id)).map(f => ({ ...f, sheet: requestedSheet }));
    fileIndex = new Map(currentFiles.map(f => [f.id, f]));
    for (const id of selectedIds) if (!fileIndex.has(id)) selectedIds.delete(id);
    if (!currentFiles.length) setSelecting(false);
    renderFiles();
    loadUsage();
    return true;
  } catch (err) {
    // Keep text sync working even if file listing fails.
    return false;
  }
}

const fileAgeDays = f => (Date.now() - (f.uploadedAt || Date.now())) / 86_400_000;
const isOldFile = f => !f.kept && fileAgeDays(f) >= OLD_FILE_DAYS;
const canKeep = f => f.kept || fileAgeDays(f) >= OLD_FILE_DAYS;

// When a file arrived, the way people say it: "Just now", "Yesterday", "6 days ago".
function fileWhen(ts) {
  if (!ts) return '';
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 2) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 45) return `${days} days ago`;
  return new Date(ts).toLocaleDateString();
}

// A small mark for the kind of file: [css class, label].
function fileKind(f) {
  const ext = (String(f.name).split('.').pop() || '').toLowerCase();
  const type = f.type || '';
  if (type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'svg'].includes(ext)) return ['img', ''];
  if (type === 'application/pdf' || ext === 'pdf') return ['pdf', 'PDF'];
  if (['xls', 'xlsx', 'xlsm', 'numbers', 'ods'].includes(ext)) return ['sheet', 'XLS'];
  if (ext === 'csv') return ['sheet', 'CSV'];
  if (['doc', 'docx', 'pages', 'rtf', 'odt'].includes(ext)) return ['doc', 'DOC'];
  if (['ppt', 'pptx', 'key', 'odp'].includes(ext)) return ['slides', 'PPT'];
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return ['zip', 'ZIP'];
  if (type.startsWith('video/') || ['mov', 'mp4', 'm4v', 'webm', 'avi'].includes(ext)) return ['video', 'VID'];
  if (type.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'aac', 'flac'].includes(ext)) return ['audio', 'AUD'];
  if (type.startsWith('text/') || ['txt', 'md', 'json', 'log'].includes(ext)) return ['text', 'TXT'];
  return ['file', ext && ext.length <= 4 ? ext.toUpperCase() : 'FILE'];
}

function fileIconHtml(f, { view = false } = {}) {
  const [kind, label] = fileKind(f);
  const opens = view ? ` data-view="${escapeHtml(f.id)}"` : '';
  if (kind === 'img' && f.thumb) {
    const src = escapeHtml(filesUrl(f.sheet, `id=${encodeURIComponent(f.id)}&thumb=1`));
    return `<span class="file-icon kind-img has-thumb" aria-hidden="true"${opens}><img src="${src}" alt="" loading="lazy" decoding="async" /></span>`;
  }
  return `<span class="file-icon kind-${kind}" aria-hidden="true"${opens}>${kind === 'img' ? icon('landscape') : escapeHtml(label)}</span>`;
}

// ---- Thumbnails for image files ----
// A 120px square made in the browser and stored with the file, so the list
// never downloads a whole photo just to show it small.

const THUMB_PX = 120;
const THUMB_BACKFILL_MAX = 12 * 1000 * 1000;
const thumbTried = new Set();
let thumbBackfillTimer = null;

async function makeThumb(blob) {
  try {
    const source = await loadBitmap(blob);
    const scale = Math.max(THUMB_PX / source.width, THUMB_PX / source.height);
    const w = source.width * scale;
    const h = source.height * scale;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = THUMB_PX;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#19263b';
    ctx.fillRect(0, 0, THUMB_PX, THUMB_PX);
    ctx.drawImage(source, (THUMB_PX - w) / 2, (THUMB_PX - h) / 2, w, h);
    source.close?.();
    const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    return out && out.size <= 64 * 1024 ? out : null;
  } catch {
    // Unreadable here (HEIC outside Safari, say): the row keeps its icon.
    return null;
  }
}

function sendThumb(sheet, id, thumb) {
  return fetch(filesUrl(sheet, `id=${encodeURIComponent(id)}&thumb=1`), {
    method: 'PUT',
    headers: { 'Content-Type': thumb.type },
    body: thumb
  }).then(r => r.ok).catch(() => false);
}

// Images uploaded before thumbnails existed: make theirs once, on whichever
// device shows them first (small images only; big ones keep the icon).
function scheduleThumbBackfill() {
  clearTimeout(thumbBackfillTimer);
  thumbBackfillTimer = setTimeout(backfillThumbs, 800);
}

async function backfillThumbs() {
  const sheet = activeSheet;
  const todo = currentFiles.filter(f => fileKind(f)[0] === 'img' && !f.thumb && !thumbTried.has(f.id) && (f.size || 0) <= THUMB_BACKFILL_MAX);
  let made = 0;
  for (const f of todo) {
    if (sheet !== activeSheet || document.visibilityState !== 'visible') break;
    thumbTried.add(f.id);
    try {
      const parts = [];
      for (let i = 0; i < f.chunks; i++) {
        const r = await fetch(filesUrl(f.sheet, `id=${encodeURIComponent(f.id)}&chunk=${i}`));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        parts.push(await r.arrayBuffer());
      }
      const thumb = await makeThumb(new Blob(parts, { type: f.type || 'image/jpeg' }));
      if (thumb && await sendThumb(f.sheet, f.id, thumb)) made++;
    } catch {
      // Try again next time the app opens.
    }
  }
  if (made && sheet === activeSheet) loadFiles(true, sheet);
}

// A thumbnail that won't load falls back to the icon.
fileList.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.closest('.file-icon')) return;
  const span = img.parentElement;
  span.classList.remove('has-thumb');
  span.innerHTML = icon('landscape');
}, true);

function renderFiles() {
  fileList.innerHTML = currentFiles.map(f => {
    const id = escapeHtml(f.id);
    const name = escapeHtml(f.name);
    const when = f.kept ? `${fileWhen(f.uploadedAt)} · Kept` : fileWhen(f.uploadedAt);
    const meta = `${bytes(f.size || 0)} · <span class="age">${escapeHtml(when)}</span>`;
    const metaTitle = escapeHtml(`${bytes(f.size || 0)} · uploaded ${new Date(f.uploadedAt).toLocaleString()}`);
    if (selecting) {
      const checked = selectedIds.has(f.id);
      return `
      <label class="file-row selectable${checked ? ' selected' : ''}" role="listitem">
        <input class="check" type="checkbox" data-select="${id}"${checked ? ' checked' : ''} aria-label="Select ${name}" />
        ${fileIconHtml(f)}
        <span class="file-main">
          <span class="file-title" title="${name}">${name}</span>
          <span class="file-meta">${meta}</span>
        </span>
      </label>`;
    }
    return `
      <div class="file-row${isOldFile(f) ? ' is-old' : ''}" role="listitem" data-id="${id}">
        <button class="swipe-delete" type="button" tabindex="-1" aria-hidden="true">Delete</button>
        <div class="file-row-inner">
          ${fileIconHtml(f, { view:true })}
          <div class="file-main">
            <button class="file-name" type="button" data-view="${id}" title="${name}">${name}</button>
            <div class="file-meta" title="${metaTitle}">${meta}</div>
          </div>
          <button class="icon-btn" type="button" data-save="${id}" aria-label="Download ${name}" title="Download">${icon('download')}</button>
          <button class="icon-btn" type="button" data-file-menu="${id}" aria-label="More actions for ${name}" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
        </div>
      </div>`;
  }).join('');
  openSwipeRow = null;
  swipe = null;
  emptyFiles.hidden = currentFiles.length > 0;
  selectBtn.hidden = !currentFiles.length;
  updateSelectionUi();
  updateOldFilesNote();
  updateAttachLink();
  if (!selecting && currentFiles.some(f => !f.thumb && !thumbTried.has(f.id) && fileKind(f)[0] === 'img')) scheduleThumbBackfill();
}

// "2 attachments" at the foot of the editor, counting this sheet's files.
function updateAttachLink() {
  const count = currentFiles.length;
  attachLink.hidden = !count;
  attachText.textContent = `${count} attachment${count === 1 ? '' : 's'}`;
}

attachLink.addEventListener('click', () => {
  filesSection.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block:'start' });
  filesHeading.focus({ preventScroll:true });
});

// ---- Storage meter ----

async function loadUsage() {
  try {
    const r = await fetch(`${API_STATE}?meta=usage`, { cache:'no-store' });
    if (!r.ok) return;
    const { bytes: used, quota } = await r.json();
    const share = quota ? used / quota : 0;
    storageText.classList.toggle('near', share >= 0.8 && share < 1);
    storageText.classList.toggle('full', share >= 1);
    storageText.textContent = quota ? `${bytes(used)} of ${bytes(quota)} used` : `${bytes(used)} used`;
  } catch {
    // The meter is a nicety; uploads are still checked on the server.
  }
}

// ---- Gentle nudge for forgotten files ----

function snoozeKey(sheet = activeSheet) {
  return `scratchpad:oldFilesSnooze:${account?.email || ''}:${sheet}`;
}

function snoozed() {
  try {
    return Date.now() - Number(localStorage.getItem(snoozeKey()) || 0) < SNOOZE_MS;
  } catch {
    return false;
  }
}

function updateOldFilesNote() {
  const old = currentFiles.filter(isOldFile);
  oldFilesNote.hidden = !old.length || selecting || snoozed();
  if (oldFilesNote.hidden) return;
  const size = old.reduce((sum, f) => sum + (f.size || 0), 0);
  const one = old.length === 1;
  oldFilesTitle.textContent = one ? '1 file is over a month old' : `${old.length} files are over a month old`;
  oldFilesText.textContent = one
    ? `Review it to see if you still need it. It uses ${bytes(size)}.`
    : `Review them to see if you still need them. Together, they use ${bytes(size)}.`;
}

document.querySelector('#oldFilesReview').addEventListener('click', () => {
  const old = currentFiles.filter(isOldFile).map(f => f.id);
  setSelecting(true);
  selectedIds = new Set(old);
  renderFiles();
  showToast('Untick anything you still need, then tap Delete');
});

document.querySelector('#oldFilesLater').addEventListener('click', () => {
  try {
    localStorage.setItem(snoozeKey(), String(Date.now()));
  } catch {
    // Private browsing: the note just shows again next time.
  }
  oldFilesNote.hidden = true;
});

// ---- Select mode ----

function selectedFiles() {
  return currentFiles.filter(f => selectedIds.has(f.id));
}

function setSelecting(on) {
  if (on === selecting) return;
  selecting = on;
  selectedIds = new Set();
  document.body.classList.toggle('selecting', on);
  renderFiles();
}

// "Sheet 5 · 3 files" under the Files title (just the sheet while loading).
function updateFilesSubtitle() {
  const loading = !currentFiles.length && emptyFiles.hidden;
  const n = currentFiles.length;
  filesHint.textContent = loading ? currentSheetName() : `${currentSheetName()} · ${n} file${n === 1 ? '' : 's'}`;
}

function updateSelectionUi() {
  const files = selectedFiles();
  updateFilesSubtitle();
  selectBar.hidden = !selecting;
  const all = currentFiles.length > 0 && files.length === currentFiles.length;
  selectAllBox.checked = all;
  bulkCount.textContent = `${files.length} selected`;
  bulkSaveBtn.disabled = bulkDeleteBtn.disabled = !files.length;
  bulkDeleteBtn.setAttribute('aria-label', files.length ? `Delete ${files.length} selected file${files.length === 1 ? '' : 's'}` : 'Delete selected files');
}

selectBtn.addEventListener('click', () => setSelecting(true));
document.querySelector('#selectCancelBtn').addEventListener('click', () => setSelecting(false));

selectAllBox.addEventListener('change', () => {
  selectedIds = selectAllBox.checked ? new Set(currentFiles.map(f => f.id)) : new Set();
  renderFiles();
});

fileList.addEventListener('change', e => {
  const box = e.target.closest('[data-select]');
  if (!box) return;
  if (box.checked) selectedIds.add(box.dataset.select);
  else selectedIds.delete(box.dataset.select);
  box.closest('.file-row').classList.toggle('selected', box.checked);
  updateSelectionUi();
});

// ---- Bottom sheet (confirmations and choices) ----

function openSheet({ title, text, files = [], actions }) {
  sheetTitle.textContent = title;
  sheetText.textContent = text;
  sheetItems.replaceChildren(...files.map(f => {
    const row = document.createElement('div');
    row.className = 'sheet-item';
    row.innerHTML = '<span></span><span></span>';
    row.firstChild.textContent = f.name;
    row.lastChild.textContent = bytes(f.size || 0);
    return row;
  }));
  sheetItems.hidden = !files.length;
  sheetActions.replaceChildren(...actions.map(action => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${action.kind || 'secondary'}${action.full ? ' full' : ''}`;
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      closeSheet();
      action.run?.();
    });
    return btn;
  }));
  sheetActions.dataset.count = String(actions.length);
  rememberFocus();
  sheetModal.hidden = false;
  document.body.classList.add('modal-open');
  sheetActions.querySelector('.btn.secondary')?.focus({ preventScroll:true });
}

function closeSheet() {
  if (sheetModal.hidden) return;
  sheetModal.hidden = true;
  if (renameModal.hidden && previewModal.hidden && adminModal.hidden) document.body.classList.remove('modal-open');
  restoreFocus();
}

sheetModal.addEventListener('click', e => { if (e.target === sheetModal) closeSheet(); });

// ---- Downloads ----

// Fetches one chunk, reporting bytes as they stream in.
async function fetchChunk(url, signal, onBytes) {
  // Chunks never change, so the browser may keep them (opening again is free).
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!r.body) {
    const buf = await r.arrayBuffer();
    onBytes(buf.byteLength);
    return buf;
  }
  const reader = r.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    onBytes(received);
  }
  return new Blob(parts);
}

async function fetchSharedFile(file, { signal, onProgress } = {}) {
  const loaded = new Array(file.chunks).fill(0);
  const parts = new Array(file.chunks);
  const report = () => onProgress?.(loaded.reduce((a, b) => a + b, 0));

  await runPool(file.chunks, PARALLEL_CHUNKS, async i => {
    parts[i] = await withRetry(() => {
      loaded[i] = 0;
      const url = file.chunkUrl ? file.chunkUrl(i) : filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}&chunk=${i}`);
      return fetchChunk(url, signal, n => {
        loaded[i] = n;
        report();
      });
    }, signal);
  });

  return new File(parts, file.name || 'file', { type: file.type || 'application/octet-stream' });
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function downloadPreparedFile(file) {
  const objectUrl = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = file.name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}

function canNativeShareFile(file) {
  return Boolean(navigator.share && (!navigator.canShare || navigator.canShare({ files:[file] })));
}

async function sharePreparedFile(file) {
  if (canNativeShareFile(file)) {
    await navigator.share({ files:[file], title:file.name });
    return true;
  }
  return false;
}

async function saveSharedFile(file) {
  const transfer = createTransfer(file.name, 'Downloading', file.size);
  try {
    const prepared = await fetchSharedFile(file, { signal: transfer.signal, onProgress: transfer.update });
    transfer.done(`Downloaded · ${bytes(file.size)}`);

    if (isIOS()) {
      // Try the native share sheet immediately. If iOS has already consumed the
      // original tap while the file was loading, keep the prepared File in memory
      // and show an in-app screen. A second tap on Save then opens Share reliably.
      try {
        if (await sharePreparedFile(prepared)) return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }

      previewFile = file;
      previewLoadedFile = prepared;
      previewTitle.textContent = file.name || 'File';
      previewBody.innerHTML = '<div class="preview-fallback"><strong>File ready.</strong><span>Tap Download above, then choose Save to Files.</span></div>';
      previewModal.hidden = false;
      document.body.classList.add('modal-open');
      return;
    }

    downloadPreparedFile(prepared);
  } catch (err) {
    transfer.fail(err?.name === 'AbortError' ? 'Download cancelled' : 'Download failed');
  }
}

// ---- Preview ----

function clearPreviewObjectUrl() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
}

async function openPreview(file) {
  clearPreviewObjectUrl();
  previewAbort?.abort();
  const controller = new AbortController();
  previewAbort = controller;
  previewFile = file;
  previewLoadedFile = null;
  if (previewModal.hidden) rememberFocus();
  previewTitle.textContent = file.name || 'File';
  previewBody.innerHTML = `
    <div class="preview-loading">
      <span class="preview-loading-text">Loading preview…</span>
      <div class="transfer-bar"><div class="transfer-fill"></div></div>
    </div>`;
  const loadingText = previewBody.querySelector('.preview-loading-text');
  const loadingFill = previewBody.querySelector('.transfer-fill');
  previewModal.hidden = false;
  document.body.classList.add('modal-open');

  try {
    const prepared = await fetchSharedFile(file, {
      signal: controller.signal,
      onProgress: loaded => {
        const pct = file.size ? Math.min(100, Math.floor((loaded / file.size) * 100)) : 100;
        loadingFill.style.width = `${pct}%`;
        loadingText.textContent = `Loading preview… ${bytes(loaded)} of ${bytes(file.size)} · ${pct}%`;
      }
    });
    if (previewAbort !== controller) return;
    previewLoadedFile = prepared;
    previewObjectUrl = URL.createObjectURL(prepared);
    const mime = prepared.type || '';
    const name = String(file.name || '');

    if (mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'preview-image';
      img.alt = name || 'File preview';
      img.src = previewObjectUrl;
      previewBody.replaceChildren(img);
      return;
    }

    if (mime.startsWith('video/') || mime.startsWith('audio/')) {
      const media = document.createElement(mime.startsWith('video/') ? 'video' : 'audio');
      media.className = 'preview-media';
      media.controls = true;
      media.playsInline = true;
      media.src = previewObjectUrl;
      previewBody.replaceChildren(media);
      return;
    }

    if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
      const frame = document.createElement('iframe');
      frame.className = 'preview-frame';
      frame.title = name || 'PDF preview';
      frame.src = previewObjectUrl;
      previewBody.replaceChildren(frame);
      return;
    }

    const fallback = document.createElement('div');
    fallback.className = 'preview-fallback';
    fallback.innerHTML = '<strong>Preview is not available for this file type.</strong><span>Tap Download to get the file (on iPhone, it opens the share sheet).</span>';
    previewBody.replaceChildren(fallback);
  } catch (err) {
    if (err?.name === 'AbortError' || previewAbort !== controller) return;
    previewBody.innerHTML = '<div class="preview-fallback"><strong>Could not load this file.</strong><span>Try Download instead.</span></div>';
  }
}

// Full-screen view of an image in the text, with Save and Remove.
function openImageViewer(img) {
  clearPreviewObjectUrl();
  previewAbort?.abort();
  previewAbort = null;
  viewedImage = img;
  previewFile = { inline:true, src: img.getAttribute('src') };
  previewLoadedFile = null;
  previewTitle.textContent = 'Image';
  previewRemoveBtn.hidden = false;
  const view = document.createElement('img');
  view.className = 'preview-image';
  view.alt = 'Image';
  view.src = img.src;
  previewBody.replaceChildren(view);
  previewModal.hidden = false;
  document.body.classList.add('modal-open');
}

// Downloads an image's untouched original (in chunks, with progress) and saves it.
async function saveOriginalImage(src) {
  const params = new URL(src, location.origin).searchParams;
  const sheet = validSheet(params.get('sheet'));
  const id = encodeURIComponent(params.get('id') || '');
  try {
    const r = await fetch(imageUrl(sheet, `id=${id}&info=1`), { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const info = await r.json();
    const ext = ((info.type.split('/')[1] || 'png').replace('jpeg', 'jpg'));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const name = `Scratch Pad image ${stamp}.${ext}`;
    const file = { name, type: info.type, size: info.size, chunks: info.chunks, sheet, chunkUrl: i => imageUrl(sheet, `id=${id}&chunk=${i}`) };
    const transfer = createTransfer(name, 'Downloading original', info.size);
    transferList.scrollIntoView({ block:'nearest', behavior:'smooth' });
    try {
      const prepared = await fetchSharedFile(file, { signal: transfer.signal, onProgress: transfer.update });
      await deliverFiles([prepared], transfer, name);
    } catch (err) {
      transfer.fail(err?.name === 'AbortError' ? 'Download cancelled' : 'Download failed');
    }
  } catch {
    showToast('Could not download image');
  }
}

previewRemoveBtn.addEventListener('click', () => {
  const img = viewedImage;
  closePreview();
  if (img?.isConnected) {
    img.remove();
    onEditorChanged();
  }
});

function closePreview() {
  viewedImage = null;
  previewRemoveBtn.hidden = true;
  previewAbort?.abort();
  previewAbort = null;
  previewModal.hidden = true;
  previewBody.innerHTML = '';
  previewFile = null;
  previewLoadedFile = null;
  clearPreviewObjectUrl();
  if (renameModal.hidden) document.body.classList.remove('modal-open');
  restoreFocus();
}

previewModal.querySelectorAll('[data-close-preview]').forEach(btn => btn.addEventListener('click', closePreview));
previewSaveBtn.addEventListener('click', async () => {
  if (!previewFile) return;
  try {
    if (previewLoadedFile) {
      if (isIOS() && await sharePreparedFile(previewLoadedFile)) return;
      downloadPreparedFile(previewLoadedFile);
      return;
    }
    if (previewFile.inline) {
      const src = previewFile.src;
      closePreview();
      await saveOriginalImage(src);
      return;
    }
    await saveSharedFile(previewFile);
  } catch (err) {
    if (err?.name !== 'AbortError') showToast('Could not download file');
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!sheetModal.hidden) closeSheet();
  else if (!adminModal.hidden) closeAdmin();
  else if (!previewModal.hidden) closePreview();
  else if (!renameModal.hidden) closeRenameModal();
  else if (selecting) setSelecting(false);
});

// ---- Swipe a file left to delete it (touch), with Undo ----
// A short swipe reveals Delete; a long one deletes straight away. Either way
// the file is removed on the server only after the Undo message has gone.


function setRowOffset(row, x, dragging = false) {
  row.classList.toggle('swiping', dragging);
  row.querySelector('.file-row-inner').style.transform = x ? `translateX(${x}px)` : '';
}

function closeSwipeRow(row = openSwipeRow) {
  if (!row) return;
  row.classList.remove('open');
  setRowOffset(row, 0);
  if (row === openSwipeRow) openSwipeRow = null;
}

fileList.addEventListener('pointerdown', e => {
  if (selecting || e.pointerType === 'mouse' || !e.isPrimary) return;
  const inner = e.target.closest('.file-row-inner');
  if (!inner) return;
  const row = inner.parentElement;
  if (openSwipeRow && openSwipeRow !== row) closeSwipeRow();
  swipe = { row, id: e.pointerId, x0: e.clientX, y0: e.clientY, base: row.classList.contains('open') ? -SWIPE_OPEN : 0, x: 0, active: false };
});

fileList.addEventListener('pointermove', e => {
  if (!swipe || e.pointerId !== swipe.id) return;
  if (!swipe.row.isConnected) {
    swipe = null;
    return;
  }
  const dx = e.clientX - swipe.x0;
  const dy = e.clientY - swipe.y0;
  if (!swipe.active) {
    // Mostly up or down: that's a scroll, not a swipe.
    if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
      swipe = null;
      return;
    }
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    swipe.active = true;
    swipe.row.querySelector('.file-row-inner').setPointerCapture?.(e.pointerId);
  }
  swipe.x = Math.max(-swipe.row.offsetWidth, Math.min(0, swipe.base + dx));
  setRowOffset(swipe.row, swipe.x, true);
});

function endSwipe(e) {
  if (!swipe || e.pointerId !== swipe.id) return;
  const { row, active, x, base } = swipe;
  swipe = null;
  if (!active) return;
  swipeClickBlockedUntil = Date.now() + 400;
  if (e.type === 'pointercancel') {
    setRowOffset(row, base);
    return;
  }
  if (x <= -row.offsetWidth * 0.55) {
    swipeDelete(row);
  } else if (x <= -SWIPE_OPEN / 2) {
    row.classList.add('open');
    setRowOffset(row, -SWIPE_OPEN);
    openSwipeRow = row;
  } else {
    closeSwipeRow(row);
  }
}

fileList.addEventListener('pointerup', endSwipe);
fileList.addEventListener('pointercancel', endSwipe);

// A swipe ends without opening the file; a tap on an open row just closes it.
fileList.addEventListener('click', e => {
  const row = e.target.closest('.file-row');
  if (!row) return;
  if (e.target.closest('.swipe-delete')) {
    e.stopPropagation();
    swipeDelete(row);
    return;
  }
  if (Date.now() < swipeClickBlockedUntil || row === openSwipeRow) {
    e.preventDefault();
    e.stopPropagation();
    closeSwipeRow(row);
  }
}, true);

document.addEventListener('pointerdown', e => {
  if (openSwipeRow && !openSwipeRow.contains(e.target)) closeSwipeRow();
});

function swipeDelete(row) {
  const file = fileIndex.get(row.dataset.id);
  if (!file || pendingDeletes.has(file.id)) return;
  if (row === openSwipeRow) openSwipeRow = null;
  row.classList.add('removing');
  setRowOffset(row, -row.offsetWidth);
  setTimeout(() => queueFileDelete(file), prefersReducedMotion() ? 0 : 200);
}

function queueFileDelete(file) {
  const timer = setTimeout(() => commitFileDelete(file.id), UNDO_MS);
  pendingDeletes.set(file.id, { file, timer });
  currentFiles = currentFiles.filter(f => !pendingDeletes.has(f.id));
  fileIndex = new Map(currentFiles.map(f => [f.id, f]));
  renderFiles();
  showToast(`Deleted ${file.name}`, { action: 'Undo', run: () => undoFileDelete(file.id), duration: UNDO_MS });
}

function undoFileDelete(id) {
  const entry = pendingDeletes.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingDeletes.delete(id);
  if (entry.file.sheet === activeSheet) {
    showCachedFiles(activeSheet);
    loadFiles(true, activeSheet);
  }
  showToast('File kept');
}

async function commitFileDelete(id, { keepalive = false } = {}) {
  const entry = pendingDeletes.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  const { file } = entry;
  const r = await fetch(filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}`), { method:'DELETE', keepalive }).catch(() => null);
  pendingDeletes.delete(id);
  if (!r?.ok) showToast(`Couldn’t delete ${file.name}`);
  if (file.sheet === activeSheet) {
    if (!r?.ok) filesSignature = '';
    loadFiles(true, file.sheet);
  } else {
    filesCache.delete(file.sheet);
  }
}

// Leaving the page: finish deletes now rather than leave them undone.
function flushFileDeletes() {
  for (const id of [...pendingDeletes.keys()]) commitFileDelete(id, { keepalive:true });
}
window.addEventListener('pagehide', flushFileDeletes);

async function toggleKeep(file) {
  try {
    await postJson(filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}&action=keep`), { kept: !file.kept });
    showToast(file.kept ? 'Reminders back on for this file' : 'Kept: no more reminders about this file');
    await loadFiles(true, file.sheet);
  } catch {
    showToast('Couldn’t update the file');
  }
}

function confirmDeleteFile(file) {
  openSheet({
    title: 'Delete this file?',
    text: `It’ll be removed from ${currentSheetName(file.sheet)} on every device. This can’t be undone.`,
    files: [file],
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: 'Delete file',
        kind: 'danger-solid',
        run: async () => {
          const r = await fetch(filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}`), { method:'DELETE' }).catch(() => null);
          if (r?.ok) {
            showToast('File deleted');
            if (file.sheet === activeSheet) await loadFiles(true, file.sheet);
          } else {
            showToast('Couldn’t delete the file');
          }
        }
      }
    ]
  });
}

function openFileMenu(trigger, file) {
  openMenu(trigger, [
    { label: 'Preview', icon: 'eye', run: () => openPreview(file) },
    { label: 'Download', icon: 'download', run: () => saveSharedFile(file) },
    canKeep(file) ? { label: file.kept ? 'Stop keeping' : 'Keep (no reminders)', icon: 'pin', run: () => toggleKeep(file) } : null,
    'separator',
    { label: 'Delete file…', icon: 'trash', danger: true, run: () => confirmDeleteFile(file) }
  ], `Actions for ${file.name}`);
}

fileList.addEventListener('click', async (e) => {
  const viewBtn = e.target.closest('[data-view]');
  if (viewBtn) {
    // The thumbnail can't hold focus; the name can, so focus returns there.
    if (viewBtn.classList.contains('file-icon')) viewBtn.closest('.file-row')?.querySelector('.file-name')?.focus({ preventScroll:true });
    const file = fileIndex.get(viewBtn.dataset.view);
    if (file) await openPreview(file);
    return;
  }

  const saveBtn = e.target.closest('[data-save]');
  if (saveBtn) {
    const file = fileIndex.get(saveBtn.dataset.save);
    if (!file) return;
    saveBtn.disabled = true;
    await saveSharedFile(file);
    saveBtn.disabled = false;
    return;
  }

  const menuBtn = e.target.closest('[data-file-menu]');
  if (menuBtn) {
    const file = fileIndex.get(menuBtn.dataset.fileMenu);
    if (file) openFileMenu(menuBtn, file);
  }
});

// ---- Saving and deleting several files ----

function shareFiles(files) {
  if (!navigator.share || (navigator.canShare && !navigator.canShare({ files }))) return false;
  return navigator.share({ files }).then(() => true);
}

function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'files';
}

// Hands finished files to the user: the share sheet on iOS, downloads elsewhere.
async function deliverFiles(files, transfer, label) {
  if (isIOS() && navigator.share) {
    try {
      if (await shareFiles(files)) {
        transfer.done(`${label} saved`);
        return;
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        transfer.done(`${label} ready`);
        return;
      }
    }
    // iOS only opens Share right after a tap, so ask for one more.
    transfer.ready(`${label} ready`, 'Save to Files', async () => {
      try {
        return await shareFiles(files);
      } catch (err) {
        return err?.name === 'AbortError' ? false : (showToast('Could not open Share'), false);
      }
    });
    return;
  }
  for (const file of files) {
    downloadPreparedFile(file);
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  transfer.done(`${label} downloaded`);
}

async function saveFiles(files, asZip) {
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  const transfer = createTransfer(`Downloading ${count}${asZip ? ' as .zip' : ''}`, 'Downloading', total, files.map(f => f.name));
  const prepared = [];
  let finishedBytes = 0;
  try {
    for (const [i, file] of files.entries()) {
      transfer.item(i, '0%');
      prepared.push(await fetchSharedFile(file, {
        signal: transfer.signal,
        onProgress: loaded => {
          transfer.update(finishedBytes + loaded);
          transfer.item(i, `${file.size ? Math.floor((loaded / file.size) * 100) : 100}%`);
        }
      }));
      finishedBytes += file.size || 0;
      transfer.item(i, 'Done', 'done');
    }
    if (!asZip) {
      await deliverFiles(prepared, transfer, count);
      return;
    }
    transfer.status('Zipping…');
    const zipName = `${safeFileName(currentSheetName(files[0].sheet))} - ${count}.zip`;
    const zip = await makeZip(prepared, zipName);
    await deliverFiles([zip], transfer, zipName);
  } catch (err) {
    transfer.fail(err?.name === 'AbortError' ? 'Download cancelled' : 'Download failed');
  }
}

bulkSaveBtn.addEventListener('click', () => {
  const files = selectedFiles();
  if (!files.length) return;
  setSelecting(false);
  if (files.length === 1) {
    saveSharedFile(files[0]);
    return;
  }
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
  openSheet({
    title: `Download ${files.length} files`,
    text: `${bytes(total)} total. Download them one by one, or bundled into a single .zip file.`,
    files,
    actions: [
      { label: 'Separate files', kind: 'primary', run: () => saveFiles(files, false) },
      { label: 'One .zip file', run: () => saveFiles(files, true) },
      { label: 'Cancel', kind: 'secondary', full: true }
    ]
  });
});

bulkDeleteBtn.addEventListener('click', () => {
  const files = selectedFiles();
  if (!files.length) return;
  const sheetName = currentSheetName(files[0].sheet);
  openSheet({
    title: `Delete ${files.length} file${files.length === 1 ? '' : 's'}?`,
    text: `They’ll be removed from ${sheetName} on every device. This can’t be undone.`,
    files,
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: `Delete ${files.length}`,
        kind: 'danger-solid',
        run: async () => {
          setSelecting(false);
          const results = await Promise.all(files.map(f =>
            fetch(filesUrl(f.sheet, `id=${encodeURIComponent(f.id)}`), { method:'DELETE' }).then(r => r.ok).catch(() => false)
          ));
          const failed = results.filter(ok => !ok).length;
          showToast(failed ? `${failed} file${failed === 1 ? '' : 's'} could not be deleted` : `Deleted ${files.length} file${files.length === 1 ? '' : 's'}`);
          await loadFiles(true, files[0].sheet);
        }
      }
    ]
  });
});

// ---- Zip (stored, no compression: photos, video and PDFs are already compressed) ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytesArr) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytesArr.length; i++) c = CRC_TABLE[(c ^ bytesArr[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function uniqueZipName(name, used) {
  const base = safeFileName(name || 'file');
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    const dot = base.lastIndexOf('.');
    candidate = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

async function makeZip(files, zipName) {
  const encoder = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const used = new Set();
  const body = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;

  for (const file of files) {
    const name = encoder.encode(uniqueZipName(file.name, used));
    const crc = crc32(new Uint8Array(await file.arrayBuffer()));
    const size = file.size;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    body.push(local.buffer, name, file);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    directory.push(central.buffer, name);

    offset += 30 + name.length + size;
    directorySize += 46 + name.length;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new File([...body, ...directory, end.buffer], zipName, { type:'application/zip' });
}

// ---- Uploads ----

// Sends one chunk with XHR so the browser reports upload progress.
function putChunk(url, blob, signal, onBytes, contentType = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once:true });
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = e => onBytes(e.loaded);
    xhr.onload = () => {
      signal.removeEventListener('abort', onAbort);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`HTTP ${xhr.status}`));
    };
    xhr.onerror = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Network error'));
    };
    xhr.onabort = () => reject(abortError());
    xhr.send(blob);
  });
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify(body || {})
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const err = new Error(data.error || 'Request failed');
    err.status = r.status;
    err.quota = Boolean(data.quota);
    throw err;
  }
  return r.json();
}

async function uploadFile(file, targetSheet, transfer) {
  let id = null;
  try {
    const start = await postJson(filesUrl(targetSheet, 'action=start'), { name:file.name, type:file.type, size:file.size });
    id = start.id;
    const thumbPromise = fileKind({ name: file.name, type: file.type })[0] === 'img' ? makeThumb(file) : Promise.resolve(null);
    const loaded = new Array(start.chunks).fill(0);
    const report = () => transfer.update(loaded.reduce((a, b) => a + b, 0));
    transfer.update(0);

    await runPool(start.chunks, PARALLEL_CHUNKS, async i => {
      if (transfer.signal.aborted) throw abortError();
      const blob = file.slice(i * start.chunkSize, Math.min(file.size, (i + 1) * start.chunkSize));
      const url = filesUrl(targetSheet, `id=${encodeURIComponent(id)}&chunk=${i}`);
      await withRetry(() => {
        loaded[i] = 0;
        return putChunk(url, blob, transfer.signal, n => {
          loaded[i] = n;
          report();
        });
      }, transfer.signal);
      loaded[i] = blob.size;
      report();
    });

    transfer.status('Finishing…');
    const thumb = await thumbPromise;
    if (thumb) await sendThumb(targetSheet, id, thumb);
    await postJson(filesUrl(targetSheet, `id=${encodeURIComponent(id)}&action=finish`));
    transfer.done(`Uploaded to ${currentSheetName(targetSheet)} · ${bytes(file.size)}`);
    return true;
  } catch (err) {
    if (id) fetch(filesUrl(targetSheet, `id=${encodeURIComponent(id)}`), { method:'DELETE' }).catch(() => {});
    if (err?.name === 'AbortError') transfer.fail('Upload cancelled');
    else if (err?.quota) transfer.fail(err.message);
    else transfer.fail('Upload failed. Check your connection and retry.', () => uploadFiles([file], targetSheet));
    return false;
  }
}

async function uploadFiles(files, targetSheet = activeSheet) {
  fileInput.value = '';
  if (!hasSheet(targetSheet)) return;
  const queue = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      showToast(`${file.name} is over ${bytes(MAX_FILE_BYTES)}`);
      continue;
    }
    queue.push({ file, transfer: createTransfer(file.name, 'Uploading', file.size) });
  }

  for (const { file, transfer } of queue) {
    if (transfer.signal.aborted) {
      transfer.fail('Upload cancelled');
      continue;
    }
    const ok = await uploadFile(file, targetSheet, transfer);
    if (ok && targetSheet === activeSheet) await loadFiles(true, targetSheet);
  }
}

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => uploadFiles([...fileInput.files]));

// Dragging files from the computer: the files section becomes a drop target
// only while a drag is in progress. Images dropped on the editor still go into
// the text; drops anywhere else are ignored rather than opening the file.
const draggingFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;

function endFileDrag() {
  dragDepth = 0;
  document.body.classList.remove('dragging-files');
  filesSection.classList.remove('drag-active');
}

window.addEventListener('dragenter', e => {
  if (!draggingFiles(e) || selecting) return;
  dragDepth++;
  document.body.classList.add('dragging-files');
});
window.addEventListener('dragleave', e => {
  if (!draggingFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) endFileDrag();
});
window.addEventListener('dragover', e => {
  if (draggingFiles(e) && !pad.contains(e.target)) e.preventDefault();
});
window.addEventListener('drop', e => {
  if (draggingFiles(e) && !pad.contains(e.target)) e.preventDefault();
  endFileDrag();
});
window.addEventListener('dragend', endFileDrag);

filesSection.addEventListener('dragover', e => {
  if (!draggingFiles(e) || selecting) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  filesSection.classList.add('drag-active');
});
filesSection.addEventListener('dragleave', e => {
  if (!filesSection.contains(e.relatedTarget)) filesSection.classList.remove('drag-active');
});
filesSection.addEventListener('drop', e => {
  if (!draggingFiles(e) || selecting) return;
  e.preventDefault();
  e.stopPropagation();
  const files = [...e.dataTransfer.files];
  endFileDrag();
  if (files.length) uploadFiles(files);
});

// Leaving the page: save any pending edit right away.
// Coming back: jump to whichever sheet was last opened on any device.
let hiddenAt = 0;

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    flushFileDeletes();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saveState(activeSheet);
    }
    return;
  }
  if (!appStarted) return;
  checkForChanges();
  connectSync();
  // Away for a while, changes from other devices may have been missed.
  if (Date.now() - hiddenAt > 60_000) {
    for (const id of [...filesCache.keys()]) if (id !== activeSheet) filesCache.delete(id);
    prefetchSheets();
  }
  await fetchSheets();
  const sheet = await fetchCurrentSheet();
  if (sheet && sheet !== activeSheet && !saveTimer && !saving) await switchSheet(sheet, { remember:false });
});

// ---- Account ----

const rawFetch = window.fetch.bind(window);
let appStarted = false;

// Signed out elsewhere ("sign out everywhere", a password reset): back to sign-in.
window.fetch = async (...args) => {
  const r = await rawFetch(...args);
  if (r.status === 401 && appStarted) location.replace('/');
  return r;
};

accountBtn.addEventListener('click', () => {
  openMenu(accountBtn, [
    { heading: account?.email || 'Account' },
    account?.admin ? { label: 'Admin: accounts', icon: 'shield', run: openAdmin } : null,
    { label: 'Sign out', icon: 'logout', run: () => signOut('logout') },
    'separator',
    { label: 'Sign out everywhere…', icon: 'devices', danger: true, run: confirmSignOutEverywhere }
  ], 'Account');
});

function confirmSignOutEverywhere() {
  openSheet({
    title: 'Sign out everywhere?',
    text: 'Every device signed in to this account, including this one, will need your password again. Your sheets and files stay.',
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      { label: 'Sign out everywhere', kind: 'danger-solid', run: () => signOut('logout-all') }
    ]
  });
}

// ---- Admin: accounts, data used, activity ----

function timeAgo(ts) {
  if (!ts) return '—';
  const minutes = Math.round((Date.now() - ts) / 60000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 45) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

function adminFact(label, value) {
  const el = document.createElement('div');
  el.append(`${label}: `);
  const b = document.createElement('b');
  b.textContent = value;
  el.append(b);
  return el;
}

function renderAdmin(data) {
  const stat = (value, label) => {
    const el = document.createElement('div');
    el.className = 'admin-stat';
    const strong = document.createElement('strong');
    strong.textContent = value;
    const span = document.createElement('span');
    span.textContent = label;
    el.append(strong, span);
    return el;
  };
  const summary = document.createElement('div');
  summary.className = 'admin-summary';
  summary.append(stat(String(data.count), data.count === 1 ? 'account' : 'accounts'), stat(bytes(data.totalBytes), 'data stored in total'));

  const list = document.createElement('div');
  list.className = 'admin-list';
  for (const a of data.accounts) {
    const row = document.createElement('div');
    row.className = 'admin-row';
    const email = document.createElement('div');
    email.className = 'admin-email';
    email.textContent = a.email;
    if (a.owner) {
      const badge = document.createElement('span');
      badge.className = 'admin-badge';
      badge.textContent = 'You';
      email.append(badge);
    }
    const facts = document.createElement('div');
    facts.className = 'admin-facts';
    facts.append(
      adminFact('Storage', `${bytes(a.bytes)} of ${a.quota ? bytes(a.quota) : 'no limit'} · ${a.files} file${a.files === 1 ? '' : 's'} · ${a.images} image${a.images === 1 ? '' : 's'}`),
      adminFact('Active', a.activeDays30 === null ? '—' : `${a.activeDays30} of last 30 days`),
      adminFact('Last seen', timeAgo(a.lastSeenAt)),
      adminFact('Sign-ins', a.loginCount === null ? '—' : `${a.loginCount}, last ${timeAgo(a.lastLoginAt)}`),
      adminFact('Joined', a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—')
    );
    const change = document.createElement('button');
    change.type = 'button';
    change.className = 'link-btn admin-limit';
    change.textContent = 'Change storage limit';
    change.addEventListener('click', () => changeLimit(a));
    row.append(email, facts, change);
    list.append(row);
  }
  const note = document.createElement('p');
  note.className = 'admin-note';
  note.textContent = '“Active” counts the days an account opened Scratch Pad. Sign-ins count password and email-code sign-ins.';
  adminBody.replaceChildren(summary, list, note);
}

async function changeLimit(a) {
  const current = a.quota ? (a.quota / 1024 ** 3).toFixed(1).replace(/\.0$/, '') : '0';
  const answer = prompt(`Storage limit for ${a.email}, in GB.\n0 = no limit. Leave empty for the default (5 GB).`, current);
  if (answer === null) return;
  try {
    await postJson('/.netlify/functions/admin', { email: a.email, limitGb: answer.trim() === '' ? null : Number(answer) });
    showToast('Storage limit updated');
    openAdmin();
    loadUsage();
  } catch (err) {
    showToast(err.message || 'Couldn’t change the limit');
  }
}

async function openAdmin() {
  rememberFocus();
  adminBody.textContent = 'Loading…';
  adminModal.hidden = false;
  adminModal.querySelector('[data-close-admin]').focus({ preventScroll:true });
  document.body.classList.add('modal-open');
  try {
    const r = await fetch('/.netlify/functions/admin', { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    renderAdmin(await r.json());
  } catch {
    adminBody.textContent = 'Couldn’t load accounts. Try again.';
  }
}

function closeAdmin() {
  if (adminModal.hidden) return;
  adminModal.hidden = true;
  if (renameModal.hidden && previewModal.hidden) document.body.classList.remove('modal-open');
  restoreFocus();
}

adminModal.querySelector('[data-close-admin]').addEventListener('click', closeAdmin);
adminModal.addEventListener('click', e => { if (e.target === adminModal) closeAdmin(); });

async function signOut(action) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveState(activeSheet);
  }
  await rawFetch(`${API_AUTH}?action=${action}`, { method:'POST' }).catch(() => {});
  location.replace('/');
}

async function authPost(action, body) {
  const r = await rawFetch(`${API_AUTH}?action=${action}`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

let authEmail = '';
let passwordToken = '';

function showAuth(step) {
  document.body.classList.add('signed-out');
  authScreen.hidden = false;
  for (const form of authScreen.querySelectorAll('.auth-step')) {
    const active = form.dataset.step === step;
    form.hidden = !active;
    if (active) {
      form.querySelector('.auth-error').textContent = '';
      for (const input of form.querySelectorAll('input[type="email"]')) if (!input.value) input.value = authEmail;
    }
  }
  if (step === 'code') document.querySelector('#codeEmailLabel').textContent = authEmail;
  if (step === 'password') document.querySelector('#passwordEmail').value = authEmail;
  const first = authScreen.querySelector(`.auth-step[data-step="${step}"] input:not([hidden]):not([type="checkbox"])`);
  requestAnimationFrame(() => {
    const target = step === 'signin' && first?.value ? document.querySelector('#signinPassword') : first;
    target?.focus();
  });
}

// Runs a form's request with its button disabled and errors shown under it.
function authForm(id, run) {
  const form = document.querySelector(id);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const button = form.querySelector('.auth-submit');
    const error = form.querySelector('.auth-error');
    error.textContent = '';
    button.disabled = true;
    try {
      await run(form);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
}

authForm('#signinForm', async () => {
  authEmail = document.querySelector('#signinEmail').value.trim();
  await authPost('login', { email: authEmail, password: document.querySelector('#signinPassword').value });
  location.replace('/');
});

async function requestCode() {
  await authPost('request-code', { email: authEmail });
  document.querySelector('#codeInput').value = '';
  showAuth('code');
}

authForm('#emailForm', async () => {
  authEmail = document.querySelector('#codeEmail').value.trim();
  if (!authEmail) throw new Error('Enter your email address');
  await requestCode();
});

authForm('#codeForm', async () => {
  const data = await authPost('verify-code', { email: authEmail, code: document.querySelector('#codeInput').value });
  passwordToken = data.token;
  document.querySelector('#passwordTitle').textContent = data.existing ? 'Choose a new password' : 'Choose a password';
  showAuth('password');
});

authForm('#passwordForm', async () => {
  const password = document.querySelector('#newPassword').value;
  if (password.length < 8) throw new Error('Use at least 8 characters.');
  await authPost('set-password', { token: passwordToken, password });
  location.replace('/');
});

// The eye button in a password box shows or hides what was typed.
authScreen.addEventListener('click', e => {
  const btn = e.target.closest('[data-reveal]');
  if (!btn) return;
  const input = btn.parentElement.querySelector('input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  input.focus();
});

// The email step serves both new accounts and forgotten passwords.
function setEmailMode(mode) {
  const create = mode !== 'reset';
  document.querySelector('#emailTitle').textContent = create ? 'Create your account' : 'Reset your password';
  document.querySelector('#emailText').innerHTML = create
    ? 'Enter your email. We’ll send a code like <strong>otter4821</strong> to confirm it’s you, then you’ll choose a password.'
    : 'Enter your account’s email. We’ll send a code like <strong>otter4821</strong>, then you’ll choose a new password.';
  document.querySelector('#emailSubmit').textContent = create ? 'Continue' : 'Email me a code';
}

authScreen.addEventListener('click', async e => {
  const go = e.target.closest('[data-go]');
  if (go) {
    if (go.dataset.mode) setEmailMode(go.dataset.mode);
    const typed = authScreen.querySelector('.auth-step:not([hidden]) input[type="email"]')?.value.trim();
    if (typed) authEmail = typed;
    showAuth(go.dataset.go);
    return;
  }
  if (e.target.closest('[data-resend]')) {
    const error = document.querySelector('#codeForm .auth-error');
    try {
      await requestCode();
      showToast('New code sent');
    } catch (err) {
      error.textContent = err.message;
    }
  }
});

async function startApp() {
  document.body.classList.remove('signed-out');
  authScreen.hidden = true;
  avatarEl.textContent = (account.email || '?').charAt(0).toUpperCase();
  accountBtn.title = account.email;
  accountBtn.setAttribute('aria-label', `Account: ${account.email}`);
  await fetchSheets();
  renderTabs();
  const startSheet = (await fetchCurrentSheet()) || rememberedSheet() || sheets[0].id;
  prefetchSheets();
  await switchSheet(startSheet, { remember:false, force:true });
  appStarted = true;
  connectSync();
  // Every 2 seconds while the relay is down; once a minute as a safety net otherwise.
  setInterval(() => {
    if (!socketHealthy || Date.now() - lastCheckAt > SAFETY_CHECK_MS) checkForChanges();
  }, POLL_MS);
}

// ---- Real-time sync: the relay tells this device when something changed ----

async function connectSync() {
  if (!appStarted || socket || reconnectTimer || document.visibilityState !== 'visible') return;
  try {
    const r = await fetch(`${API_SYNC}?action=ticket`, { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { url, ticket } = await r.json();
    if (!url) return; // Relay not set up: the 2-second check carries on.
    const ws = new WebSocket(`${url}?ticket=${encodeURIComponent(ticket)}`);
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      socketHealthy = true;
      reconnectDelay = 1000;
      startPings(ws);
      checkForChanges(); // Catch anything missed while disconnected.
    };
    ws.onmessage = e => {
      if (e.data === 'pong') {
        clearTimeout(pongTimer);
        return;
      }
      try {
        onSyncNotice(JSON.parse(e.data));
      } catch {
        // Ignore anything unexpected.
      }
    };
    ws.onclose = () => dropSocket(ws);
    ws.onerror = () => dropSocket(ws);
  } catch {
    scheduleReconnect();
  }
}

function dropSocket(ws) {
  if (socket !== ws) return;
  socket = null;
  socketHealthy = false;
  clearInterval(pingTimer);
  clearTimeout(pongTimer);
  try { ws.close(); } catch { /* already closed */ }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSync();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
}

// A connection can die silently (sleeping phone, changed network): no pong
// within 10 seconds means reconnect.
function startPings(ws) {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send('ping');
    clearTimeout(pongTimer);
    pongTimer = setTimeout(() => dropSocket(ws), 10_000);
  }, PING_MS);
}

function onSyncNotice(notice) {
  if (notice?.type !== 'changed') return;
  // Signed out elsewhere: the check gets a 401 and goes back to sign-in.
  if (notice.part === 'session') {
    checkForChanges();
    return;
  }
  const other = /^(text|files)-(\d+)$/.exec(String(notice.part || ''));
  if (other && Number(other[2]) !== activeSheet) {
    if (ownRevs.get(notice.part) !== notice.rev) refreshOtherSheet(Number(other[2]), other[1]);
    return;
  }
  const known =
    notice.part === 'sheets' ? revs.sheets :
    notice.part === `text-${activeSheet}` ? revs.text :
    notice.part === `files-${activeSheet}` ? revs.files :
    undefined;
  if (notice.part !== 'sheets' && known === undefined && !notice.part.endsWith(`-${activeSheet}`)) return;
  if (notice.rev !== known) checkForChanges();
}

// One small request every 2 seconds while Scratch Pad is on screen; the
// text, tabs or file list are fetched only when their marker changed.
async function checkForChanges() {
  if (!appStarted || document.visibilityState !== 'visible') return;
  if (checking) {
    // A notice arrived mid-check: look again right after.
    clearTimeout(retryCheckTimer);
    retryCheckTimer = setTimeout(checkForChanges, 300);
    return;
  }
  checking = true;
  lastCheckAt = Date.now();
  const sheet = activeSheet;
  let behind = false;
  try {
    const r = await fetch(`${API_CHECK}?sheet=${sheet}`, { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const next = await r.json();
    if (sheet !== activeSheet) return;
    const work = [];
    const settle = (ok, apply) => { if (ok) apply(); else behind = true; };
    if (next.sheets !== revs.sheets) work.push(fetchSheets().then(ok => settle(ok, () => { revs.sheets = next.sheets; })));
    // Mid-save the marker may already be our own save's; compare next time.
    if (next.text !== revs.text) {
      if (saving) behind = true;
      else work.push(fetchState(sheet).then(ok => settle(ok && sheet === activeSheet, () => { revs.text = next.text; })));
    }
    if (next.files !== revs.files) work.push(loadFiles(true, sheet).then(ok => settle(ok && sheet === activeSheet, () => { revs.files = next.files; })));
    await Promise.all(work);
    setConnection('live');
  } catch {
    behind = true;
    setConnection('offline');
  } finally {
    checking = false;
    // Skipped mid-edit or failed: try again shortly rather than waiting a minute.
    if (behind) {
      clearTimeout(retryCheckTimer);
      retryCheckTimer = setTimeout(checkForChanges, POLL_MS);
    }
  }
}

// Checking who is signed in also renews the one-year cookie.
const me = await rawFetch(API_AUTH, { cache:'no-store' }).catch(() => null);
if (me?.ok) {
  account = await me.json();
  await startApp();
} else {
  // The emailed link opens straight at the code step.
  const params = new URLSearchParams(location.search);
  authEmail = params.get('email') || '';
  showAuth(params.get('step') === 'code' && authEmail ? 'code' : 'signin');
  if (params.has('step')) history.replaceState(null, '', '/');
}
