import * as vault from '/crypto.js';

const API_STATE = '/.netlify/functions/state';
const API_FILES = '/.netlify/functions/files';
const API_IMAGES = '/.netlify/functions/images';
const API_AUTH = '/.netlify/functions/auth';
const API_SYNC = '/.netlify/functions/sync';
const API_CHECK = '/api/check';
const SAFETY_CHECK_MS = 5 * 60_000; // while live sync is connected (it brings changes at once)
const OLD_FILE_DAYS = 30;
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const PING_MS = 25_000;
const POLL_MS = 2000;
const SAVE_DELAY_MS = 1500; // a save goes out this long after typing stops…
const SAVE_MAX_WAIT_MS = 5000; // …and at least this often while typing goes on
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const PARALLEL_CHUNKS = 3;
const CHUNK_RETRIES = 5;
const STUCK_AFTER_RETURN_MS = 8000;
const STALLED_MS = 30000; // a transfer piece with no progress for this long is started again
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
const bulkShareBtn = document.querySelector('#bulkShareBtn');
// Share sends the files themselves to the system share menu, where there is one.
bulkShareBtn.hidden = bulkShareBtn.nextElementSibling.hidden = typeof navigator.share !== 'function';
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
// Version history: the next save asks the server to keep the text it replaces
// as a version (clearing, restoring); so does one that drops most of the text.
let nextSaveCheckpoint = false;
const savedLength = new Map(); // sheet → length of its text as last saved or loaded
let unsavedSince = 0; // when the first edit not yet sent was made
let saving = false;
let lastInputAt = 0;
let lastFileRefresh = 0;
let sheets = [{ id: 1, name: 'Sheet 1' }];
let sheetsSignature = '';
let account = null;
// Instant open (see near the end): the kept copy's size cap, its save timer,
// and whether it's on screen and not yet checked against the server.
const SNAPSHOT_MAX_CHARS = 4_000_000;
let snapshotTimer = null;
let painted = null;
// Last change markers seen; the 2-second check compares against these.
let revs = {};
let checking = false;
let lastCheckAt = 0;
let retryCheckTimer = null;
// Live connection to the relay; while it's healthy the 2-second check is off.
let socket = null;
let socketHealthy = false;
// The relay (sync and R2 files) is blocked on some networks (a workplace
// filter, say). Then file pieces come through Netlify instead, new files are
// stored there, and the server tells other devices about this one's saves.
let relayBlockedAt = 0;
const RELAY_BLOCK_MEMORY_MS = 30 * 60_000;
const relayBlocked = () => Date.now() - relayBlockedAt < RELAY_BLOCK_MEMORY_MS;
const relayUsable = () => socketHealthy && !relayBlocked();
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
// Share links still working, by "kind:sheet:file" (see "Share links").
let liveShares = new Map();

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
// ---- Offline: view only ----
// Sync has no merge (the last save wins), so nothing is edited while this
// device can't reach the server. A blip doesn't count: view-only starts after
// OFFLINE_GRACE_MS without a connection (at once if the device says it has no
// network). Words typed just before stay on screen and are saved on return.
const OFFLINE_GRACE_MS = 3000;
let viewOnly = false;
let appStarted = false;
let offlineTimer = null;

function enterViewOnly() {
  clearTimeout(offlineTimer);
  offlineTimer = null;
  if (viewOnly || !appStarted) return;
  viewOnly = true;
  document.body.classList.add('view-only');
  pad.contentEditable = 'false';
  if (document.activeElement === pad) pad.blur();
  renderConnectionLabel();
  // Said once as it happens; again only if they try to type.
  offlineNotice();
}

function exitViewOnly() {
  clearTimeout(offlineTimer);
  offlineTimer = null;
  if (!viewOnly) return;
  viewOnly = false;
  document.body.classList.remove('view-only');
  // Words typed just before the connection dropped are saved first.
  if ((saveTimer || saveStateName === 'failed' || saveStateName === 'unsaved') && !saving) {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveState(activeSheet);
  }
  if (!pad.classList.contains('is-loading')) pad.contentEditable = 'true';
  renderConnectionLabel();
}

// Still no connection after the grace period? Ask the server once more before
// locking (one failed request elsewhere isn't being offline).
async function confirmOffline() {
  offlineTimer = null;
  if (viewOnly || !appStarted) return;
  const r = await rawFetch(`${API_CHECK}?sheet=${activeSheet}`, { cache: 'no-store' }).catch(() => null);
  if (r?.ok) setConnection('live');
  else if (statusEl.dataset.state !== 'live') enterViewOnly();
}

// Changes need the server: offline, say why and do nothing.
function blockedOffline() {
  if (!viewOnly) return false;
  offlineNotice();
  return true;
}

const OFFLINE_NOTICE = 'You’re offline. Reconnect to edit.';
function offlineNotice() {
  showToast(OFFLINE_NOTICE, { duration: 2600 });
}

function renderConnectionLabel() {
  const state = statusEl.dataset.state;
  const label = state === 'live' ? 'Connected' : state === 'offline' ? (viewOnly ? 'Offline · view only' : 'Offline') : 'Connecting…';
  statusEl.title = state === 'live' ? 'Connected: changes sync across your devices' : viewOnly ? 'Offline: view only until you’re connected again' : label;
  statusEl.querySelector('.conn-label').textContent = label;
}

window.addEventListener('offline', () => {
  setConnection('offline');
  enterViewOnly();
});
window.addEventListener('online', () => { if (appStarted) checkForChanges(); });

function setConnection(state) {
  if (state === 'offline' && appStarted && !viewOnly && !offlineTimer) offlineTimer = setTimeout(confirmOffline, OFFLINE_GRACE_MS);
  if (state === 'live') {
    clearTimeout(offlineTimer);
    offlineTimer = null;
    if (viewOnly) {
      statusEl.dataset.state = state;
      exitViewOnly();
      return;
    }
  }
  if (statusEl.dataset.state === state) return;
  const wasOffline = statusEl.dataset.state === 'offline';
  statusEl.dataset.state = state;
  // Back online after a failed save: try that save again on its own.
  if (state === 'live' && wasOffline && saveStateName === 'failed') {
    setTimeout(() => {
      if (saveStateName === 'failed' && !saving && !saveTimer) saveState(activeSheet);
    }, 0);
  }
  renderConnectionLabel();
}

// Save state of the open sheet, shown in the editor toolbar beside the
// connection dot. "Synced" only ever follows a confirmed write (or content
// loaded from the server).
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
  }[saveStateName] || (localUpdatedAt ? `Synced · ${formatSavedTime(localUpdatedAt)}` : 'Nothing saved yet');
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

// ---- End-to-end encryption: the keys this device holds while signed in ----
// The master key (from the password, or the recovery key) opens each sheet's
// key; a sheet's key locks its text, name and pasted images, and opens the keys
// of its files. Only locked content ever leaves this device. See crypto.js.

let masterKey = null;
const sheetKeys = new Map();   // sheet id -> { wrapped, key }
const fileKeys = new Map();    // file id -> key
const knownFiles = new Map();  // file id -> file as listed (with its locked key and sheet)
const isLocked = () => Boolean(masterKey);

async function sheetKeyFrom(id, wrapped) {
  const known = sheetKeys.get(id);
  if (known?.wrapped === wrapped) return known.key;
  const key = await vault.unwrap(wrapped, masterKey);
  sheetKeys.set(id, { wrapped, key });
  return key;
}

// The key of a live sheet (from its entry in the list).
async function keyForSheet(id) {
  const entry = sheets.find(s => s.id === id);
  if (entry?.key) return sheetKeyFrom(id, entry.key);
  const known = sheetKeys.get(id)?.key;
  if (known) return known;
  throw new Error('This sheet isn’t ready yet. Reload ScrapSheet and try again.');
}

async function fileKeyFor(file, sheet = file.sheet) {
  if (fileKeys.has(file.id)) return fileKeys.get(file.id);
  const key = await vault.unwrap(file.key, await keyForSheet(sheet));
  fileKeys.set(file.id, key);
  return key;
}

// The sheet list with names unlocked (sheets without a key yet keep theirs).
async function openSheetList(data) {
  if (!Array.isArray(data?.sheets) || !masterKey) return data;
  const list = await Promise.all(data.sheets.map(async s => {
    if (!s.key) return s;
    try {
      return { ...s, name: await vault.decryptText(await sheetKeyFrom(Number(s.id), s.key), s.name) };
    } catch {
      return { ...s, name: 'Locked sheet' };
    }
  }));
  return { ...data, sheets: list };
}

// Every sheet gets a key the first time this device sees it without one.
async function ensureSheetKeys() {
  if (!masterKey) return;
  for (const s of sheets.filter(entry => !entry.key)) {
    const key = await vault.newKey();
    await postSheets({ action: 'set-key', sheet: s.id, key: await vault.wrap(key, masterKey), name: await vault.encryptText(key, s.name) });
  }
}

// A sheet's text as html: unlocked if locked, as it is if from before encryption.
async function sheetHtml(sheet, data) {
  if (vault.isSealed(data?.html)) return vault.decryptText(await keyForSheet(sheet), data.html);
  return typeof data?.html === 'string' ? data.html : textToHtml(data?.text || '');
}

// File lists with names unlocked; each file is remembered for its key and thumbnail.
async function openFiles(list, sheet) {
  const opened = await Promise.all(list.map(async f => {
    const file = { ...f, sheet };
    knownFiles.set(f.id, file);
    if (!f.enc) return file;
    try {
      const key = await fileKeyFor(file, sheet);
      return { ...file, name: await vault.decryptText(key, f.name), type: await vault.decryptText(key, f.type) };
    } catch {
      return { ...file, name: 'Locked file' };
    }
  }));
  opened.signature = JSON.stringify(list);
  return opened;
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
  sheetCache.set(sheet, { html, updatedAt, content: htmlHasContent(html) });
  scheduleTabStatus();
  scheduleSnapshot();
}

// Text (ignoring whitespace) or an image counts as content.
const contentProbe = document.createElement('template');
function htmlHasContent(html) {
  contentProbe.innerHTML = html || '';
  const content = contentProbe.content;
  return Boolean(content.querySelector('img') || content.textContent.trim());
}

// ---- Under each tab's name: Empty, a text mark, and/or a paperclip with the file count ----
// sheetStatus holds what the server reported when the app opened; fresher
// copies (the open editor, kept text, kept file lists) take over as they arrive.
const sheetStatus = new Map();
let tabStatusFrame = 0;

function scheduleTabStatus() {
  if (!tabStatusFrame) tabStatusFrame = requestAnimationFrame(() => { tabStatusFrame = 0; updateTabStatus(); });
}

function statusFor(id) {
  const reported = sheetStatus.get(id);
  const loaded = id === activeSheet && !pad.classList.contains('is-loading');
  const content = loaded ? !editorIsEmpty() : sheetCache.has(id) ? sheetCache.get(id).content : reported?.content;
  const list = id === activeSheet && (currentFiles.length || !emptyFiles.hidden) ? currentFiles : filesCache.get(id)?.filter(f => !pendingDeletes.has(f.id));
  const files = list ? list.length : reported?.files;
  return { content, files };
}

function updateTabStatus() {
  for (const tab of sheetTabsEl.querySelectorAll('.sheet-tab')) {
    const id = Number(tab.dataset.sheet);
    const { content, files } = statusFor(id);
    const row = tab.querySelector('.sheet-status');
    const parts = [];
    let html = '';
    if (content === undefined && files === undefined) {
      html = '';
    } else if (!content && !files) {
      html = '<span>Empty</span>';
      parts.push('empty');
    } else {
      if (content) { html += icon('lines'); parts.push('has text'); }
      if (files) { html += `<span class="tab-files">${icon('clip')}${files}</span>`; parts.push(`${files} file${files === 1 ? '' : 's'}`); }
    }
    if (row.innerHTML !== html) row.innerHTML = html;
    const name = sheets.find(s => s.id === id)?.name || '';
    tab.setAttribute('aria-label', parts.length ? `${name}, ${parts.join(', ')}` : name);
  }
}

// One request for every sheet's text, made when the app opens.
async function prefetchSheets() {
  try {
    const r = await fetch(`${API_STATE}?meta=all`, { cache:'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    if (Array.isArray(data.shares)) setLiveShares(data.shares);
    for (const s of data.status || []) {
      const id = Number(s.id);
      sheetStatus.set(id, { content: Boolean(s.content), files: Number(s.files) || 0 });
      if (id !== activeSheet && Array.isArray(s.fileList) && hasSheet(id)) filesCache.set(id, await openFiles(s.fileList, id));
    }
    for (const s of data.sheets || []) {
      if (!hasSheet(Number(s.id))) continue;
      cacheSheet(Number(s.id), await sheetHtml(Number(s.id), s), Number(s.updatedAt || 0));
    }
    scheduleTabStatus();
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
      if (kind === 'files') { filesCache.set(sheet, await openFiles(Array.isArray(data.files) ? data.files : [], sheet)); scheduleTabStatus(); }
      else cacheSheet(sheet, await sheetHtml(sheet, data), Number(data.updatedAt || 0));
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
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9Z"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  theme: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17a8.5 8.5 0 0 0 0-17Z" fill="currentColor" stroke="none"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  eraser: '<path d="M20 20H9l-4.5-4.5a2 2 0 0 1 0-2.8L13 4.2a2 2 0 0 1 2.8 0l4 4a2 2 0 0 1 0 2.8L12 19"/><path d="m8 10 6 6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  pin: '<path d="M12 17v4M8 3h8l-1 6 3 3v2H6v-2l3-3-1-6Z"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  lines: '<path d="M5 7h14M5 12h14M5 17h14"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  share: '<path d="M12 15V4M7 8.5 12 4l5 4.5M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5"/>',
  clip: '<path d="M21 11.5 12.6 19.9a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/>',
  landscape: '<path d="M2.5 19 8.5 11l4.5 5.5 3-3.5 5.5 6z" fill="currentColor" stroke="none"/><circle cx="16.5" cy="7.5" r="2.2" fill="currentColor" stroke="none"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5L5 20"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h12"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2.2h8.6A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17.2h.01"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  back: '<path d="m14.5 6-6 6 6 6"/>',
  open: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  devices: '<rect x="3" y="4" width="13" height="10" rx="1.5"/><path d="M7 18h5M17 9h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"/>'
};

const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;

// ---- Returning focus after a dialog closes ----

// Each dialog keeps its own place to return to, so one opened on top of
// another (a confirmation over Recently Deleted) doesn't lose the first.
const returnFocusTo = new Map();

function rememberFocus(dialog) {
  const el = document.activeElement;
  returnFocusTo.set(dialog, el && el !== document.body ? el : null);
}

function restoreFocus(dialog) {
  const el = returnFocusTo.get(dialog);
  returnFocusTo.delete(dialog);
  if (el?.isConnected) el.focus({ preventScroll:true });
}

// Pages behind a dialog don't scroll while any dialog is open.
function updateModalOpen() {
  const open = [...document.querySelectorAll('.modal-backdrop')].some(el => !el.hidden);
  document.body.classList.toggle('modal-open', open);
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
      btn.className = `menu-item${item.danger ? ' danger' : ''}${item.checked !== undefined ? ' menu-choice' : ''}`;
      btn.setAttribute('role', item.checked !== undefined ? 'menuitemradio' : 'menuitem');
      if (item.checked !== undefined) btn.setAttribute('aria-checked', String(Boolean(item.checked)));
      btn.tabIndex = -1;
      btn.innerHTML = item.icon ? icon(item.icon) : '';
      const text = document.createElement('span');
      text.textContent = item.label;
      btn.append(text);
      if (item.checked) btn.insertAdjacentHTML('beforeend', `<span class="menu-check">${icon('check')}</span>`);
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

  const entries = () => [...el.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')];
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
    const status = document.createElement('span');
    status.className = 'sheet-status';
    status.setAttribute('aria-hidden', 'true');
    tab.append(label, status);
    return tab;
  }));
  updateTabStatus();
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
  sheets = data.sheets.map(s => ({ id: Number(s.id), name: String(s.name || `Sheet ${s.id}`), ...(s.key ? { key: s.key } : {}) }));
  for (const id of [...sheetCache.keys(), ...filesCache.keys()]) if (!hasSheet(id)) forgetSheet(id);
  renderTabs();
  scheduleSnapshot();
  // The open sheet was deleted on another device.
  if (!hasSheet(activeSheet)) switchSheet(sheets[0].id, { remember:false, force:true });
}

async function fetchSheets() {
  try {
    const r = await fetch(sheetsUrl(), { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    applySheets(await openSheetList(await r.json()));
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
  if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { data });
  const opened = await openSheetList(data);
  applySheets(opened);
  return opened;
}

async function fetchState(sheet = activeSheet) {
  const requestedSheet = validSheet(sheet);
  try {
    const r = await fetch(stateUrl(requestedSheet), { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (requestedSheet !== activeSheet) return false;
    const remoteHtml = await sheetHtml(requestedSheet, data);
    if (requestedSheet !== activeSheet) return false;

    const remoteTs = Number(data.updatedAt || 0);
    const recentlyTyping = Date.now() - lastInputAt < 850;

    const busy = saving || recentlyTyping || resizingImage || pendingImageUploads > 0;
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
  if (targetSheet === activeSheet) unsavedSince = 0;
  const filled = !editorIsEmpty();
  saving = true;
  if (targetSheet === activeSheet) setSaveState('saving');
  try {
    // Locked before it leaves: the server keeps only whether it holds anything
    // and which images it uses.
    const body = isLocked()
      ? {
        text: '',
        html: await vault.encryptText(await keyForSheet(targetSheet), htmlToSave),
        filled,
        images: [...new Set([...htmlToSave.matchAll(/[?&;]id=([A-Za-z0-9-]{1,64})/g)].map(m => m[1]))]
      }
      : { text: textToSave, html: htmlToSave };
    // Can't reach the relay: the server tells the other devices instead.
    if (!relayUsable()) body.notify = 1;
    const before = savedLength.get(targetSheet);
    if (nextSaveCheckpoint || (before > 40 && textToSave.length < before * 0.5)) body.checkpoint = 1;
    nextSaveCheckpoint = false;
    const payload = JSON.stringify(body);
    const r = await fetch(stateUrl(targetSheet), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      // Small enough to finish even if the page is being closed.
      keepalive: payload.length < 60_000
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    tellOtherDevices(data.notice);
    cacheSheet(targetSheet, htmlToSave, Number(data.updatedAt || Date.now()));
    savedLength.set(targetSheet, textToSave.length);
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
    // A save that can't reach the server counts as being offline (view only
    // follows if it lasts); one the server refused doesn't.
    if (err instanceof TypeError) setConnection('offline');
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
  // Saved once typing pauses, and at least every few seconds during a long
  // stretch of typing (each save is a server call, and other devices fetch it).
  if (!unsavedSince) unsavedSince = Date.now();
  const wait = Math.max(0, Math.min(SAVE_DELAY_MS, unsavedSince + SAVE_MAX_WAIT_MS - Date.now()));
  saveTimer = setTimeout(() => { saveTimer = null; saveState(sheetAtInput); }, wait);
}

// After a save, this device passes the server's signed notice to the sync
// relay, which tells the account's other devices (the server doesn't wait on
// it). If it can't get through, they still find out on their own check.
function tellOtherDevices(notice) {
  if (!notice?.url || !notice?.token) return;
  fetch(notice.url, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: notice.token }).catch(() => {});
}

pad.addEventListener('input', onEditorChanged);

// Text and images only: block bold/italic and other formatting shortcuts.
pad.addEventListener('beforeinput', e => {
  if (e.inputType.startsWith('format')) e.preventDefault();
});

copyBtn.addEventListener('click', async () => {
  const text = pad.innerText;
  const html = serializeEditor().replace(/<img[^>]*>/g, '');
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
  if (blockedOffline()) return;
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
          const sheet = activeSheet;
          const before = serializeEditor();
          nextSaveCheckpoint = true;
          pad.replaceChildren();
          onEditorChanged();
          showToast(`Cleared ${name}`, {
            action: 'Undo',
            duration: 6000,
            run: () => { if (putTextBack(sheet, before)) showToast(`The text in ${name} is back`); }
          });
        }
      }
    ]
  });
}

sheetMenuBtn.addEventListener('click', () => {
  openMenu(sheetMenuBtn, [
    { label: 'Rename sheet', icon: 'pencil', run: openRenameModal },
    { label: 'Version history…', icon: 'restore', run: openHistory },
    { label: liveShareFor('sheet', activeSheet) ? 'Shared link…' : 'Share sheet…', icon: 'link', run: () => openShare({ kind: 'sheet', sheet: activeSheet, name: currentSheetName() }) },
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

// A pasted image keeps its server address in data-src (what is saved). What
// shows is an unlocked copy in memory (see showPadImages); until then, a blank.
const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

function makePadImage(src, width = null) {
  const img = document.createElement('img');
  img.dataset.src = src;
  img.setAttribute('src', BLANK_IMAGE);
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
      const src = node.getAttribute('data-src') || node.getAttribute('src') || '';
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
  scheduleTabStatus();
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
  showPadImages(pad);
  if (caret !== null) placeCaret(caret);
  updateEmptyState();
  positionImageTools();
  savedLength.set(activeSheet, pad.innerText.length);
}

// Puts earlier text back in the editor and saves it now, keeping what it
// replaces as a version (so this can be undone too).
function putTextBack(sheet, html) {
  if (blockedOffline()) return false;
  if (sheet !== activeSheet) {
    showToast('Open that sheet again to undo');
    return false;
  }
  renderEditor(html);
  nextSaveCheckpoint = true;
  onEditorChanged();
  clearTimeout(saveTimer);
  saveTimer = null;
  saveState(sheet);
  return true;
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

// Unlocked copies of pasted images, by server address (an address always shows the same image).
const imageUrls = new Map();

function imageObjectUrl(src) {
  if (!imageUrls.has(src)) {
    imageUrls.set(src, (async () => {
      const r = await fetch(src);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let data = new Uint8Array(await r.arrayBuffer());
      let type = (r.headers.get('content-type') || '').split(';')[0];
      if (type === 'application/octet-stream') {
        const sheet = validSheet(new URL(src, location.origin).searchParams.get('sheet'));
        const key = await keyForSheet(sheet);
        data = await vault.decryptBytes(key, data);
        type = await vault.decryptText(key, r.headers.get('x-image-type') || '');
      }
      return URL.createObjectURL(new Blob([data], { type }));
    })().catch(err => {
      imageUrls.delete(src);
      throw err;
    }));
  }
  return imageUrls.get(src);
}

function showPadImages(root) {
  for (const img of root.querySelectorAll('img.pad-image[data-src]')) {
    const src = img.dataset.src;
    imageObjectUrl(src).then(url => { if (img.dataset.src === src) img.src = url; }).catch(() => img.classList.add('broken'));
  }
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
  let keepLocalUrl = false;
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

    // Locked with the sheet's key: the display copy and every piece of the original.
    const key = isLocked() ? await keyForSheet(sheet) : null;
    const seal = async part => key ? new Blob([await vault.encryptBytes(key, new Uint8Array(await part.arrayBuffer()))]) : part;
    const wait = why => transfer.waiting(why);
    const startBody = { type: key ? await vault.encryptText(key, type) : type, size: blob.size, ...(key ? { enc: 1 } : {}) };
    const start = await withRetry(() => postJson(imageUrl(sheet, 'action=start'), startBody), transfer.signal, wait);
    const id = encodeURIComponent(start.id);
    const loaded = new Array(start.chunks).fill(0);
    const report = () => transfer.update(loaded.reduce((a, b) => a + b, 0));
    if (preview) {
      const sealedPreview = await seal(preview);
      const previewType = key ? await vault.encryptText(key, preview.type) : preview.type;
      await withRetry(() => putChunk(imageUrl(sheet, `id=${id}&preview=1&type=${encodeURIComponent(previewType)}`), sealedPreview, transfer.signal, () => {}, key ? 'application/octet-stream' : preview.type), transfer.signal, wait);
    }
    await runPool(start.chunks, PARALLEL_CHUNKS, async i => {
      const part = await seal(blob.slice(i * start.chunkSize, Math.min(blob.size, (i + 1) * start.chunkSize)));
      await withRetry(() => {
        loaded[i] = 0;
        return putChunk(imageUrl(sheet, `id=${id}&chunk=${i}`), part, transfer.signal, n => {
          loaded[i] = n;
          report();
        }).catch(err => {
          loaded[i] = 0;
          report();
          throw err;
        });
      }, transfer.signal, wait);
    });
    const { src } = await withRetry(() => postJson(imageUrl(sheet, `id=${id}&action=finish`)), transfer.signal, wait);
    // Keeps showing the local copy, which is also what this address now shows.
    img.dataset.src = src;
    imageUrls.set(src, Promise.resolve(localUrl));
    keepLocalUrl = true;
    delete img.dataset.pending;
    img.classList.remove('pending');
    transfer.done(`Image added · ${bytes(blob.size)}`);
    loadUsage();
  } catch (err) {
    img.remove();
    if (err?.upgrade) showUpgrade(err.message);
    if (transfer) transfer.fail(err?.name === 'AbortError' ? 'Upload cancelled' : err?.quota || err?.upgrade ? err.message : 'Image upload failed');
    else showToast(err?.message?.includes('over') ? err.message : 'Image upload failed');
  } finally {
    if (localUrl.startsWith('blob:') && !keepLocalUrl) setTimeout(() => URL.revokeObjectURL(localUrl), 10000);
    pendingImageUploads--;
    if (sheet === activeSheet) onEditorChanged();
  }
}

// An image being added shows its local copy straight away; it has no server address yet.
function pendingImage(src) {
  const img = makePadImage(src);
  delete img.dataset.src;
  img.setAttribute('src', src);
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

// Trying to type while offline says why it can't be edited: a tap on the text
// (not a scroll or a text selection to copy), or a typed key.
pad.addEventListener('click', () => {
  if (viewOnly && getSelection().isCollapsed) blockedOffline();
});
document.addEventListener('keydown', e => {
  if (!viewOnly || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.length !== 1 && e.key !== 'Enter' && e.key !== 'Backspace') return;
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  blockedOffline();
});

pad.addEventListener('paste', e => {
  if (viewOnly) {
    e.preventDefault();
    blockedOffline();
    return;
  }
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
  if (viewOnly) {
    e.preventDefault();
    blockedOffline();
    return;
  }
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
  painted = null;
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
  pad.contentEditable = viewOnly ? 'false' : 'true';
  scheduleTabStatus();
}

// The file list as last seen, or nothing (rather than "No files") until it loads.
function showCachedFiles(sheet) {
  const files = filesCache.get(sheet);
  filesSignature = files ? files.signature || JSON.stringify(files) : '';
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
  if (suppressTabClick) return;
  const tab = e.target.closest('.sheet-tab');
  if (tab) switchSheet(Number(tab.dataset.sheet));
});

// ---- Reordering tabs: drag one with a mouse, or touch and hold one, then drag ----
// The tab moves among the others as it passes their middles; letting go saves
// the order for every device. A quick swipe on a phone still scrolls the tabs.
let tabDrag = null;
let suppressTabClick = false;

function beginTabDrag() {
  if (!tabDrag || tabDrag.active) return;
  clearTimeout(tabDrag.hold);
  if (blockedOffline()) {
    tabDrag = null;
    return;
  }
  tabDrag.active = true;
  tabDrag.before = [...sheetTabsEl.children].map(t => t.dataset.sheet).join();
  tabDrag.tab.classList.add('dragging');
  sheetTabsEl.classList.add('reordering');
  navigator.vibrate?.(10);
}

function moveTabDrag(x) {
  const { tab } = tabDrag;
  // Near an edge of the strip: scroll it along.
  const box = tabsScroller.getBoundingClientRect();
  if (x < box.left + 30) tabsScroller.scrollLeft -= 12;
  else if (x > box.right - 30) tabsScroller.scrollLeft += 12;
  for (const other of sheetTabsEl.children) {
    if (other === tab) continue;
    const r = other.getBoundingClientRect();
    const middle = r.left + r.width / 2;
    const tabFirst = tab.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING;
    if (tabFirst && x > middle) other.after(tab);
    else if (!tabFirst && x < middle) other.before(tab);
  }
}

async function endTabDrag(cancelled = false) {
  const drag = tabDrag;
  tabDrag = null;
  if (!drag) return;
  clearTimeout(drag.hold);
  if (!drag.active) return;
  drag.tab.classList.remove('dragging');
  sheetTabsEl.classList.remove('reordering');
  // The click that ends a drag doesn't open the tab.
  suppressTabClick = true;
  setTimeout(() => { suppressTabClick = false; }, 0);
  const order = [...sheetTabsEl.children].map(t => Number(t.dataset.sheet));
  if (cancelled || order.join() === drag.before) {
    if (cancelled) renderTabs();
    return;
  }
  try {
    await postSheets({ action: 'reorder', order });
  } catch {
    showToast('Couldn’t save the new order');
    renderTabs();
  }
}

sheetTabsEl.addEventListener('pointerdown', e => {
  const tab = e.target.closest('.sheet-tab');
  if (!tab || e.button > 0 || sheets.length < 2) return;
  tabDrag = { tab, id: e.pointerId, x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse', active: false };
  if (!tabDrag.mouse) tabDrag.hold = setTimeout(beginTabDrag, 350);
});
window.addEventListener('pointermove', e => {
  if (!tabDrag || e.pointerId !== tabDrag.id) return;
  if (!tabDrag.active) {
    const moved = Math.hypot(e.clientX - tabDrag.x, e.clientY - tabDrag.y);
    // A mouse drags after a few pixels; a finger that moves before the hold is scrolling.
    if (tabDrag.mouse && moved > 6) beginTabDrag();
    else if (!tabDrag.mouse && moved > 8) return endTabDrag();
    if (!tabDrag?.active) return;
  }
  e.preventDefault();
  moveTabDrag(e.clientX);
});
window.addEventListener('pointerup', e => { if (tabDrag && e.pointerId === tabDrag.id) endTabDrag(); });
window.addEventListener('pointercancel', e => { if (tabDrag && e.pointerId === tabDrag.id) endTabDrag(tabDrag.active); });
// While dragging on a touch screen, the page doesn't scroll instead.
document.addEventListener('touchmove', e => { if (tabDrag?.active) e.preventDefault(); }, { passive: false });
sheetTabsEl.addEventListener('contextmenu', e => { if (e.target.closest('.sheet-tab') && tabDrag) e.preventDefault(); });
// Mouse: no native drag of the button's text.
sheetTabsEl.addEventListener('dragstart', e => e.preventDefault());

sheetTabsEl.addEventListener('dblclick', e => {
  const tab = e.target.closest('.sheet-tab');
  if (!tab) return;
  e.preventDefault();
  const sheet = Number(tab.dataset.sheet);
  if (sheet !== activeSheet) switchSheet(sheet).then(openRenameModal);
  else openRenameModal();
});

addSheetBtn.addEventListener('click', () => {
  if (blockedOffline()) return;
  if (sheets.length >= myPlan().sheets && myPlan().sheets < MAX_SHEETS) {
    showUpgrade('The Free plan has 1 sheet.');
    return;
  }
  addSheet();
});

async function addSheet(purge) {
  addSheetBtn.disabled = true;
  try {
    const body = purge ? { action:'add', purge } : { action:'add' };
    if (isLocked()) {
      // Its own key, and its name locked with it.
      const key = await vault.newKey();
      Object.assign(body, { key: await vault.wrap(key, masterKey), name: await vault.encryptText(key, `Sheet ${sheets.length + 1}`) });
    }
    const data = await postSheets(body);
    // A new sheet starts empty: no need to wait for it.
    forgetSheet(data.added);
    cacheSheet(data.added, '', 0);
    filesCache.set(data.added, []);
    await switchSheet(data.added);
    openRenameModal();
  } catch (err) {
    if (err.data?.upgrade) {
      showUpgrade(err.message);
      return;
    }
    const held = err.data?.purge && { ...err.data.purge };
    if (held?.key && masterKey) held.name = await vault.decryptText(await vault.unwrap(held.key, masterKey), held.name).catch(() => 'a deleted sheet');
    if (held) {
      openSheet({
        title: 'Make room for a new sheet?',
        text: `All 10 sheets are in use, counting ${held.name} in Recently Deleted. To add a sheet, ${held.name} has to be deleted for good. This can’t be undone.`,
        actions: [
          { label: 'Cancel', kind: 'secondary' },
          { label: `Delete ${held.name} for good`, kind: 'danger-solid', run: () => addSheet(held.id) }
        ]
      });
    } else {
      showToast(err.message || 'Could not add a sheet');
    }
  } finally {
    addSheetBtn.disabled = false;
  }
}

// From the sheet menu (••• in the editor toolbar).
function confirmDeleteSheet() {
  if (blockedOffline()) return;
  const sheet = activeSheet;
  const name = currentSheetName(sheet);
  closeRenameModal();
  if (sheets.length === 1) {
    showToast('You need at least one sheet');
    return;
  }
  openSheet({
    title: `Delete ${name}?`,
    text: 'It moves to Recently Deleted with its text and files, on all your devices. You can restore it for 30 days.',
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
            showToast(`Deleted ${name}`, { action: 'Undo', run: () => restoreSheet(sheet), duration: 6000 });
          } catch (err) {
            showToast(err.message || 'Delete failed');
          }
        }
      }
    ]
  });
}

// Renames the open sheet, or a file ({ file }).
let renameFile = null;
function openRenameModal({ file = null } = {}) {
  if (blockedOffline()) return;
  rememberFocus('rename');
  renameFile = file?.id ? file : null;
  renameModal.querySelector('.modal-kicker').textContent = renameFile ? 'File' : 'Current sheet';
  renameModal.querySelector('#renameTitle').textContent = renameFile ? 'Rename file' : 'Rename sheet';
  renameModal.querySelector('label[for="renameInput"]').textContent = renameFile ? 'File name' : 'Sheet name';
  renameInput.maxLength = renameFile ? 200 : 40;
  renameInput.value = renameFile ? renameFile.name : currentSheetName();
  renameModal.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    renameInput.focus();
    // A file: the name before its extension is selected, ready to type over.
    const dot = renameFile ? renameInput.value.lastIndexOf('.') : -1;
    if (dot > 0) renameInput.setSelectionRange(0, dot);
    else renameInput.select();
  });
}

function closeRenameModal() {
  if (renameModal.hidden) return;
  renameModal.hidden = true;
  updateModalOpen();
  restoreFocus('rename');
}

renameModal.querySelectorAll('[data-close-rename]').forEach(btn => btn.addEventListener('click', closeRenameModal));
renameModal.addEventListener('click', e => { if (e.target === renameModal) closeRenameModal(); });

renameForm.addEventListener('submit', async e => {
  e.preventDefault();
  if (renameFile) return renameFileSubmit(renameFile);
  const name = renameInput.value.replace(/[\r\n\t]/g, ' ').trim().slice(0, 40);
  if (!name) {
    renameInput.focus();
    return;
  }
  try {
    await postSheets({ action:'rename', sheet:activeSheet, name: isLocked() ? await vault.encryptText(await keyForSheet(activeSheet), name) : name });
    closeRenameModal();
    showToast('Sheet renamed');
  } catch {
    showToast('Rename failed');
  }
});


async function renameFileSubmit(file) {
  const name = renameInput.value.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
  if (!name) {
    renameInput.focus();
    return;
  }
  if (name === file.name) return closeRenameModal();
  if (blockedOffline()) return;
  try {
    const sealed = file.enc ? await vault.encryptText(await fileKeyFor(file), name) : name;
    await postJson(filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}&action=rename`), { name: sealed });
    closeRenameModal();
    showToast('File renamed');
    if (file.sheet === activeSheet) await loadFiles(true, file.sheet);
    libraryChanged();
  } catch {
    showToast('Couldn’t rename the file');
  }
}

// ---- Moving a file to another sheet ----
function chooseMoveTarget(file) {
  if (blockedOffline()) return;
  const others = sheets.filter(s => s.id !== file.sheet);
  const shared = liveShareFor('file', file.sheet, file.id);
  openSheet({
    title: `Move ${file.name} to…`,
    text: shared ? 'Its share link stops working once it’s moved (you can make a new one).' : 'Pick the sheet to move it to.',
    files: [file],
    actions: [
      ...others.map(s => ({ label: s.name, kind: 'secondary', full: true, run: () => moveFile(file, s.id) })),
      { label: 'Cancel', kind: 'secondary', full: true }
    ]
  });
}

// The page re-locks the file's key for the other sheet; the server copies the
// pieces one by one (the page drives it, so a big file never times out), then
// deletes the original.
async function moveFile(file, to) {
  if (blockedOffline()) return;
  const toName = currentSheetName(to);
  const transfer = createTransfer(file.name, `Moving to ${toName}`, file.size || 0);
  const wait = why => transfer.waiting(why);
  const url = action => filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}&action=${action}`);
  try {
    const key = file.enc ? await vault.wrap(await fileKeyFor(file), await keyForSheet(to)) : undefined;
    const start = await withRetry(() => postJson(url('move-start'), { to, key }), transfer.signal, wait);
    let done = 0;
    await runPool(start.chunks, PARALLEL_CHUNKS, async i => {
      await withRetry(() => postJson(url('move-piece'), { to, copy: start.copy, i }), transfer.signal, wait);
      transfer.update(Math.min(file.size || 0, ++done * Math.ceil((file.size || 0) / start.chunks)));
    });
    await withRetry(() => postJson(url('move-finish'), { to, copy: start.copy }), transfer.signal, wait);
    transfer.done(`Moved to ${toName}`);
    showToast(`Moved to ${toName}`);
    fileKeys.delete(file.id);
    await loadFiles(true, file.sheet);
    refreshFilesFor(to);
    libraryChanged();
  } catch (err) {
    if (err?.name === 'AbortError') transfer.fail('Cancelled');
    else transfer.fail(err?.message || 'Couldn’t move the file. Try again.');
  }
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1).replace(/\.0$/, '')} KB`;
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1).replace(/\.0$/, '')} MB`;
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

// ---- Patient transfers ----
// Phones pause a page that's in the background, and connections drop. A
// transfer then waits, without using up its tries, and carries on from the
// piece it was on once ScrapSheet is in front and online again (pieces already
// sent stay sent). Only a refusal from the server, or Cancel, ends it.

let lastHiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') lastHiddenAt = Date.now();
});
const pageActive = () => document.visibilityState === 'visible' && navigator.onLine && !viewOnly;

// Resolves once the page is in front and online (at once if it already is).
function whenActive(signal) {
  if (pageActive()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => { if (pageActive()) { stop(); resolve(); } };
    const cancel = () => { stop(); reject(abortError()); };
    const timer = setInterval(check, 1000);
    const stop = () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
      signal?.removeEventListener('abort', cancel);
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

// Worth trying again: no answer at all, or a server hiccup (not a refusal).
const retryable = err => !err?.status || err.status >= 500 || err.status === 408 || err.status === 429;

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
});

// `onWait(why)`: 'hidden' (paused in the background) or 'offline'.
async function withRetry(fn, signal, onWait) {
  for (let attempt = 1; ;) {
    const startedAt = Date.now();
    try {
      return await fn();
    } catch (err) {
      // Only Cancel ends a transfer; an abort the browser made (app in the
      // background) is waited out and tried again like any dropped connection.
      if (signal?.aborted) throw abortError();
      if (!retryable(err)) throw err;
      // No answer counts as offline (confirmed by one more check, as for saves).
      if (!err?.status && !viewOnly && appStarted) setConnection('offline');
      if (lastHiddenAt >= startedAt || !pageActive()) {
        // The page was away (or the connection is): wait, and this try doesn't count.
        if (!pageActive()) onWait?.(document.visibilityState === 'visible' ? 'offline' : 'hidden');
        await whenActive(signal);
        continue;
      }
      if (attempt >= CHUNK_RETRIES) throw err;
      await pause(800 * 2 ** (attempt - 1), signal);
      attempt++;
      if (!pageActive()) {
        onWait?.(document.visibilityState === 'visible' ? 'offline' : 'hidden');
        await whenActive(signal);
      }
    }
  }
}

// A request that went quiet while the page was away can hang once it's back:
// if nothing moves within a few seconds of returning, it's started again.
function restartIfStuck(isBusy, lastActivity, restart) {
  let timer = null;
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    const back = Date.now();
    clearTimeout(timer);
    timer = setTimeout(() => { if (isBusy() && lastActivity() < back) restart(); }, STUCK_AFTER_RETURN_MS);
  };
  // A connection can die without the request ever ending (the piece was sent,
  // the answer never comes). Going offline, or no progress at all for a while
  // in front, starts the piece again (it then waits for a connection).
  const onOffline = () => { if (isBusy()) restart(); };
  const watchdog = setInterval(() => {
    if (isBusy() && pageActive() && Date.now() - lastActivity() > STALLED_MS) restart();
  }, 5000);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('offline', onOffline);
  return () => {
    clearTimeout(timer);
    clearInterval(watchdog);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('offline', onOffline);
  };
}

const networkError = () => new Error('Network error');

// ---- Transfer progress rows ----

function createTransfer(name, verb, total, items = null, { note = '' } = {}) {
  const row = document.createElement('div');
  row.className = 'transfer-row';
  row.innerHTML = `
    <div class="transfer-top">
      <span class="transfer-name"></span>
      <button class="transfer-cancel" type="button" aria-label="Cancel">Cancel</button>
    </div>
    <div class="transfer-bar"><div class="transfer-fill"></div></div>
    <div class="transfer-meta"></div>
    <div class="transfer-note" hidden></div>`;
  row.querySelector('.transfer-name').textContent = name;
  const noteEl = row.querySelector('.transfer-note');
  if (note) {
    noteEl.textContent = note;
    noteEl.hidden = false;
  }
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
    noteEl.remove();
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
    // Paused: in the background, or offline. Carries on by itself.
    waiting(why) {
      meta.textContent = why === 'offline' ? 'Waiting for a connection… · continues by itself' : 'Paused while ScrapSheet was in the background · continuing…';
    },
    setTotal(n) {
      total = n;
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
    const files = await openFiles(Array.isArray(data.files) ? data.files : [], requestedSheet);
    filesCache.set(requestedSheet, files);
    scheduleSnapshot();
    if (requestedSheet !== activeSheet) return false;

    lastFileRefresh = Date.now();
    const signature = files.signature;
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
    if (f.enc) return `<span class="file-icon kind-img has-thumb" aria-hidden="true"${opens}><img data-thumb="${escapeHtml(f.id)}" alt="" /></span>`;
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

async function sendThumb(sheet, id, thumb, key = null) {
  const body = key ? new Blob([await vault.encryptBytes(key, new Uint8Array(await thumb.arrayBuffer()))]) : thumb;
  return fetch(filesUrl(sheet, `id=${encodeURIComponent(id)}&thumb=1`), {
    method: 'PUT',
    headers: { 'Content-Type': key ? 'application/octet-stream' : thumb.type },
    body
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
        const r = await fetchPiece(filesUrl(f.sheet, `id=${encodeURIComponent(f.id)}&chunk=${i}`));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        parts.push(await r.arrayBuffer());
      }
      const key = f.enc ? await fileKeyFor(f) : null;
      const plain = key ? await Promise.all(parts.map(p => vault.decryptBytes(key, new Uint8Array(p)))) : parts;
      const thumb = await makeThumb(new Blob(plain, { type: f.type || 'image/jpeg' }));
      if (thumb && await sendThumb(f.sheet, f.id, thumb, key)) made++;
    } catch {
      // Try again next time the app opens.
    }
  }
  if (made && sheet === activeSheet) loadFiles(true, sheet);
}

// Unlocked thumbnails, by file id.
const thumbUrls = new Map();

function fillThumbs(root) {
  for (const img of root.querySelectorAll('img[data-thumb]:not([src])')) {
    const file = knownFiles.get(img.dataset.thumb);
    if (!file) continue;
    if (!thumbUrls.has(file.id)) {
      thumbUrls.set(file.id, (async () => {
        const r = await fetch(filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}&thumb=1`));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await vault.decryptBytes(await fileKeyFor(file), new Uint8Array(await r.arrayBuffer()));
        return URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
      })().catch(err => {
        thumbUrls.delete(file.id);
        throw err;
      }));
    }
    thumbUrls.get(file.id).then(url => { img.src = url; }).catch(() => {
      const span = img.parentElement;
      span.classList.remove('has-thumb');
      span.innerHTML = icon('landscape');
    });
  }
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
    const shared = liveShareFor('file', f.sheet, f.id) ? `<span class="shared-tag" title="Shared by link">${icon('link')}<span class="visually-hidden">Shared by link. </span></span>` : '';
    const meta = `${shared}${bytes(f.size || 0)} · <span class="age">${escapeHtml(when)}</span>`;
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
          <button class="icon-btn" type="button" data-delete-file="${id}" aria-label="Delete ${name}" title="Delete">${icon('trash')}</button>
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
  scheduleTabStatus();
  fillThumbs(fileList);
  if (!selecting && currentFiles.some(f => !f.thumb && !thumbTried.has(f.id) && fileKind(f)[0] === 'img')) scheduleThumbBackfill();
}

// "2 attachments" at the foot of the editor, counting this sheet's files.
function updateAttachLink() {
  const count = currentFiles.length;
  attachLink.hidden = !count;
  attachText.textContent = String(count);
  const label = `${count} attachment${count === 1 ? '' : 's'}: go to Files`;
  attachLink.setAttribute('aria-label', label);
  attachLink.title = label;
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
  bulkSaveBtn.disabled = bulkShareBtn.disabled = bulkDeleteBtn.disabled = !files.length;
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
  rememberFocus('sheet');
  sheetModal.hidden = false;
  document.body.classList.add('modal-open');
  sheetActions.querySelector('.btn.secondary')?.focus({ preventScroll:true });
}

function closeSheet() {
  if (sheetModal.hidden) return;
  sheetModal.hidden = true;
  updateModalOpen();
  restoreFocus('sheet');
}

sheetModal.addEventListener('click', e => { if (e.target === sheetModal) closeSheet(); });

// ---- Downloads ----

// A file piece. Pieces in R2 come from the relay (the server redirects there);
// if that can't be reached while Netlify can, the same piece comes through
// Netlify (`via=netlify`), and so do the rest for a while.
const viaNetlify = url => `${url}${url.includes('?') ? '&' : '?'}via=netlify`;
async function fetchPiece(url, init = {}) {
  if (relayBlocked()) return fetch(viaNetlify(url), init);
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted || !navigator.onLine || document.visibilityState !== 'visible') throw err;
    const r = await fetch(viaNetlify(url), init); // fails too when truly offline
    relayBlockedAt = Date.now();
    return r;
  }
}

// Fetches one chunk, reporting bytes as they stream in.
async function fetchChunk(url, signal, onBytes) {
  const own = new AbortController();
  const onAbort = () => own.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let busy = true;
  let lastActivity = Date.now();
  let restarted = false;
  const unwatch = restartIfStuck(() => busy, () => lastActivity, () => { restarted = true; own.abort(); });
  try {
    // Chunks never change, so the browser may keep them (opening again is free).
    const r = await fetchPiece(url, { signal: own.signal });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
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
      lastActivity = Date.now();
      parts.push(value);
      received += value.byteLength;
      onBytes(received);
    }
    return new Blob(parts);
  } catch (err) {
    // Only Cancel cancels; anything else without an answer from the server
    // (a phone cutting the download off in the background) is a dropped connection.
    if (signal?.aborted) throw abortError();
    throw err?.status ? err : networkError();
  } finally {
    busy = false;
    unwatch();
    signal?.removeEventListener('abort', onAbort);
  }
}

async function fetchSharedFile(file, { signal, onProgress, onWait } = {}) {
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
      }).catch(err => {
        loaded[i] = 0;
        report();
        throw err;
      });
    }, signal, onWait);
  });

  if (file.enc) {
    const key = file.cryptoKey || await fileKeyFor(file);
    for (let i = 0; i < parts.length; i++) {
      const sealed = parts[i] instanceof Blob ? await parts[i].arrayBuffer() : parts[i];
      parts[i] = await vault.decryptBytes(key, new Uint8Array(sealed));
    }
  }
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
    const prepared = await fetchSharedFile(file, { signal: transfer.signal, onWait: transfer.waiting, onProgress: transfer.update });
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
  if (previewModal.hidden) rememberFocus('preview');
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
  previewFile = { inline:true, src: img.dataset.src || img.getAttribute('src') };
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
// What it takes to download a pasted image's untouched original (its chunks, unlocked here).
async function originalImage(src) {
  const params = new URL(src, location.origin).searchParams;
  const sheet = validSheet(params.get('sheet'));
  const id = encodeURIComponent(params.get('id') || '');
  const r = await fetch(imageUrl(sheet, `id=${id}&info=1`), { cache:'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const info = await r.json();
  const cryptoKey = info.enc ? await keyForSheet(sheet) : null;
  if (info.enc) info.type = await vault.decryptText(cryptoKey, info.type);
  const ext = (info.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  return { name: `image.${ext}`, ext, type: info.type, size: info.size, chunks: info.chunks, sheet, enc: info.enc, cryptoKey, chunkUrl: i => imageUrl(sheet, `id=${id}&chunk=${i}`) };
}

async function saveOriginalImage(src) {
  try {
    const file = await originalImage(src);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const name = file.name = `ScrapSheet image ${stamp}.${file.ext}`;
    const transfer = createTransfer(name, 'Downloading original', file.size);
    transferList.scrollIntoView({ block:'nearest', behavior:'smooth' });
    try {
      const prepared = await fetchSharedFile(file, { signal: transfer.signal, onWait: transfer.waiting, onProgress: transfer.update });
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
  updateModalOpen();
  restoreFocus('preview');
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
  if (!searchModal.hidden) closeSearch();
  else if (!sheetModal.hidden) closeSheet();
  else if (!shareModal.hidden) closeShare();
  else if (!trashModal.hidden) closeTrash();
  else if (!previewModal.hidden) closePreview();
  else if (!renameModal.hidden) closeRenameModal();
  else if (!historyModal.hidden) closeHistory();
  else if (!libraryModal.hidden) closeLibrary();
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
  if (viewOnly) {
    setRowOffset(row, 0);
    blockedOffline();
    return;
  }
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
  if (blockedOffline()) return;
  try {
    await postJson(filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}&action=keep`), { kept: !file.kept });
    showToast(file.kept ? 'Reminders back on for this file' : 'Kept: no more reminders about this file');
    if (file.sheet === activeSheet) await loadFiles(true, file.sheet);
    libraryChanged();
  } catch {
    showToast('Couldn’t update the file');
  }
}

function confirmDeleteFile(file) {
  if (blockedOffline()) return;
  openSheet({
    title: 'Delete this file?',
    text: `It moves to Recently Deleted on every device. You can restore it for 30 days.`,
    files: [file],
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: 'Delete file',
        kind: 'danger-solid',
        run: async () => {
          const r = await fetch(filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}`), { method:'DELETE' }).catch(() => null);
          if (r?.ok) {
            showToast(`Deleted ${file.name}`, { action: 'Undo', run: () => restoreFiles([file]), duration: 6000 });
            if (file.sheet === activeSheet) await loadFiles(true, file.sheet);
            else filesCache.delete(file.sheet);
            libraryChanged();
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
    { label: liveShareFor('file', file.sheet, file.id) ? 'Shared link…' : 'Share link…', icon: 'link', run: () => openShare({ kind: 'file', sheet: file.sheet, file: file.id, name: file.name }) },
    canKeep(file) ? { label: file.kept ? 'Stop keeping' : 'Keep (no reminders)', icon: 'pin', run: () => toggleKeep(file) } : null,
    { label: 'Rename…', icon: 'pencil', run: () => openRenameModal({ file }) },
    sheets.length > 1 ? { label: 'Move to…', icon: 'folder', run: () => chooseMoveTarget(file) } : null,
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

  // Delete right from the row (asks first, the same as from the ••• menu).
  const deleteBtn = e.target.closest('[data-delete-file]');
  if (deleteBtn) {
    const file = fileIndex.get(deleteBtn.dataset.deleteFile);
    if (file) confirmDeleteFile(file);
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
        onWait: transfer.waiting,
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

// The selected files, unlocked here, then handed to the system share menu
// (Messages, Mail, AirDrop, WhatsApp…). Phones only open it right after a tap,
// so if fetching took too long the row offers a Share button.
async function shareSelected(files) {
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  const transfer = createTransfer(`Sharing ${count}`, 'Preparing', total, files.map(f => f.name));
  transferList.scrollIntoView({ block:'nearest', behavior:'smooth' });
  const prepared = [];
  let finishedBytes = 0;
  try {
    for (const [i, file] of files.entries()) {
      transfer.item(i, '0%');
      prepared.push(await fetchSharedFile(file, {
        signal: transfer.signal,
        onWait: transfer.waiting,
        onProgress: loaded => {
          transfer.update(finishedBytes + loaded);
          transfer.item(i, `${file.size ? Math.floor((loaded / file.size) * 100) : 100}%`);
        }
      }));
      finishedBytes += file.size || 0;
      transfer.item(i, 'Done', 'done');
    }
  } catch (err) {
    transfer.fail(err?.name === 'AbortError' ? 'Cancelled' : 'Couldn’t get the files. Try again.');
    return;
  }
  if (navigator.canShare && !navigator.canShare({ files: prepared })) {
    transfer.fail(files.length > 1 ? 'This device can’t share these files together. Try fewer, or Download.' : 'This device can’t share this file. Try Download.');
    return;
  }
  const open = async () => {
    try {
      await navigator.share({ files: prepared });
      return true;
    } catch (err) {
      if (err?.name === 'AbortError') return true; // closed without sharing
      throw err;
    }
  };
  try {
    await open();
    transfer.done(`${count} shared`);
  } catch {
    transfer.ready(`${count} ready`, 'Share', async () => {
      try {
        return await open();
      } catch {
        showToast('Couldn’t open Share');
        return false;
      }
    });
  }
}

bulkShareBtn.addEventListener('click', () => {
  const files = selectedFiles();
  if (!files.length) return;
  setSelecting(false);
  shareSelected(files);
});

bulkDeleteBtn.addEventListener('click', () => {
  if (blockedOffline()) return;
  const files = selectedFiles();
  if (!files.length) return;
  const sheetName = currentSheetName(files[0].sheet);
  openSheet({
    title: `Delete ${files.length} file${files.length === 1 ? '' : 's'}?`,
    text: `They move to Recently Deleted on every device. You can restore them from ${sheetName} for 30 days.`,
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
          const done = files.filter((f, i) => results[i]);
          if (failed) showToast(`${failed} file${failed === 1 ? '' : 's'} could not be deleted`);
          else showToast(`Deleted ${files.length} file${files.length === 1 ? '' : 's'}`, { action: 'Undo', run: () => restoreFiles(done), duration: 6000 });
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

function crc32(bytesArr, crc = 0) {
  let c = (crc ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < bytesArr.length; i++) c = CRC_TABLE[(c ^ bytesArr[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// A blob's checksum, read in pieces (a 100 MB file never sits in memory twice).
async function blobCrc(blob) {
  let crc = 0;
  const step = 8 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += step) crc = crc32(new Uint8Array(await blob.slice(at, at + step).arrayBuffer()), crc);
  return crc;
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

// Files go in at the top, or in folders when they carry a `zipPath` ("Sheet/files/a.pdf").
// Archives past 4 GB get the Zip64 records every unzip tool reads.
async function makeZip(files, zipName, { onProgress, signal } = {}) {
  const encoder = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const usedIn = new Map(); // folder -> names taken in it
  const body = [];
  const directory = [];
  const MAX32 = 0xFFFFFFFF;
  let offset = 0;
  let directorySize = 0;
  let done = 0;

  for (const file of files) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const parts = String(file.zipPath || '').split('/').filter(Boolean);
    const folder = parts.slice(0, -1).map(safeFileName).join('/');
    if (!usedIn.has(folder)) usedIn.set(folder, new Set());
    const leaf = uniqueZipName(parts.pop() || file.name, usedIn.get(folder));
    const path = folder ? `${folder}/${leaf}` : leaf;
    const name = encoder.encode(path);
    const crc = await blobCrc(file);
    const size = file.size;
    const big = offset > MAX32;

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

    const extra = new DataView(new ArrayBuffer(big ? 12 : 0));
    if (big) {
      extra.setUint16(0, 0x0001, true);
      extra.setUint16(2, 8, true);
      extra.setBigUint64(4, BigInt(offset), true);
    }
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, big ? 45 : 20, true);
    central.setUint16(6, big ? 45 : 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint16(30, extra.byteLength, true);
    central.setUint32(42, big ? MAX32 : offset, true);
    directory.push(central.buffer, name, extra.buffer);

    offset += 30 + name.length + size;
    directorySize += 46 + name.length + extra.byteLength;
    onProgress?.(done += size);
  }

  const tail = [];
  const zip64 = offset > MAX32 || files.length > 0xFFFF;
  if (zip64) {
    const record = new DataView(new ArrayBuffer(56));
    record.setUint32(0, 0x06064b50, true);
    record.setBigUint64(4, 44n, true);
    record.setUint16(12, 45, true);
    record.setUint16(14, 45, true);
    record.setBigUint64(24, BigInt(files.length), true);
    record.setBigUint64(32, BigInt(files.length), true);
    record.setBigUint64(40, BigInt(directorySize), true);
    record.setBigUint64(48, BigInt(offset), true);
    const locator = new DataView(new ArrayBuffer(20));
    locator.setUint32(0, 0x07064b50, true);
    locator.setBigUint64(8, BigInt(offset + directorySize), true);
    locator.setUint32(16, 1, true);
    tail.push(record.buffer, locator.buffer);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Math.min(files.length, 0xFFFF), true);
  end.setUint16(10, Math.min(files.length, 0xFFFF), true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, zip64 ? MAX32 : offset, true);
  tail.push(end.buffer);
  return new File([...body, ...directory, ...tail], zipName, { type:'application/zip' });
}

// ---- Download my data ----
// Everything the account holds, in one .zip. Only this device can unlock it
// (the server never could), so it's put together here: each sheet as a web page
// and as plain text, beside its pasted images and its files, plus a summary.
// Recently Deleted isn't included.

// A sheet's text as plain text: line breaks kept, images as where they are in the folder.
function exportText(root) {
  let out = '';
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.textContent;
      else if (child.tagName === 'BR') out += '\n';
      else if (child.tagName === 'IMG') out += `${out && !out.endsWith('\n') ? '\n' : ''}[image: ${child.getAttribute('src')}]\n`;
      else if (child.tagName === 'DIV') {
        if (out && !out.endsWith('\n')) out += '\n';
        walk(child);
        if (!out.endsWith('\n')) out += '\n';
      } else walk(child);
    }
  };
  walk(root);
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function exportPage(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0 auto;max-width:760px;padding:32px 20px;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1c1c1c;background:#fffdf9;white-space:pre-wrap;overflow-wrap:anywhere}
h1{margin:0 0 20px;font-size:22px;white-space:normal} img{display:block;max-width:100%;height:auto;margin:8px 0;border-radius:8px}</style>
</head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>
`;
}

const textFile = (zipPath, text, type = 'text/plain') => Object.assign(new File([text], zipPath.split('/').pop(), { type }), { zipPath });

async function downloadMyData() {
  if (viewOnly || !navigator.onLine) {
    showToast('You’re offline. Reconnect to download your data.', { duration: 3000 });
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const zipName = `ScrapSheet data ${stamp}.zip`;
  const transfer = createTransfer(zipName, 'Downloading', 0);
  transfer.status('Gathering your sheets…');
  transferList.scrollIntoView({ block:'nearest', behavior:'smooth' });
  const { signal } = transfer;
  try {
    // 1. Every sheet's text and file list, unlocked here, and what each pasted image is.
    const used = new Set();
    const plan = [];
    for (const [i, entry] of sheets.entries()) {
      const id = validSheet(entry.id);
      const [state, list] = await Promise.all([
        fetch(stateUrl(id), { cache:'no-store', signal }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        fetch(filesUrl(id), { cache:'no-store', signal }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      ]);
      const name = String(entry.name || `Sheet ${i + 1}`);
      const folder = uniqueZipName(`${String(i + 1).padStart(2, '0')} ${name}`, used);
      const page = cleanHtml(await sheetHtml(id, state));
      const images = [];
      for (const img of page.querySelectorAll('img.pad-image')) {
        const original = await originalImage(img.dataset.src).catch(() => null);
        if (!original) { img.replaceWith('[image missing]'); continue; }
        const path = `images/image-${images.length + 1}.${original.ext}`;
        images.push({ ...original, zipPath: `${folder}/${path}` });
        img.setAttribute('src', path);
        img.removeAttribute('data-src');
        img.removeAttribute('data-width');
        img.removeAttribute('class');
      }
      const files = (await openFiles(Array.isArray(list.files) ? list.files : [], id))
        .map(f => ({ ...f, zipPath: `${folder}/files/${f.name || 'file'}` }));
      // Sheets with nothing in them get no folder (they're still listed in account.json).
      const empty = !page.textContent.trim() && !images.length && !files.length;
      plan.push({ name, folder, page, images, files, empty });
    }

    // 2. Download and unlock every image and file.
    const downloads = plan.flatMap(p => [...p.images, ...p.files]);
    const total = downloads.reduce((n, f) => n + (f.size || 0), 0);
    transfer.setTotal(total);
    let finished = 0;
    for (const item of downloads) {
      item.prepared = Object.assign(await fetchSharedFile(item, { signal, onWait: transfer.waiting, onProgress: loaded => transfer.update(finished + loaded) }), { zipPath: item.zipPath });
      finished += item.size || 0;
    }

    // 3. The .zip: README and summary first, then each sheet's page, text, images and files.
    const summary = {
      app: 'ScrapSheet',
      exportedAt: new Date().toISOString(),
      account: { email: account?.email || null, plan: myPlan().plan === 'free' ? 'free' : 'pro' },
      sheets: plan.map(p => ({ name: p.name, folder: p.empty ? null : p.folder, empty: p.empty, images: p.images.length, files: p.files.map(f => ({ name: f.name, type: f.type || null, size: f.size, uploadedAt: f.uploadedAt ? new Date(f.uploadedAt).toISOString() : null })) }))
    };
    const entries = [
      textFile('README.txt', [
        `Your ScrapSheet data, downloaded ${new Date().toLocaleString()}.`,
        '',
        'Each sheet has its own folder:',
        '  <sheet>.html  the sheet as a web page, with its images (open it in any browser)',
        '  <sheet>.txt   the same text, plain',
        '  images/       images pasted into the sheet, as they were added',
        '  files/        the files attached to the sheet',
        '',
        'account.json lists your account, sheets and files.',
        'Items in Recently Deleted are not included: restore them first if you want them.',
        ''
      ].join('\n')),
      textFile('account.json', JSON.stringify(summary, null, 2) + '\n', 'application/json')
    ];
    for (const p of plan.filter(x => !x.empty)) {
      entries.push(
        textFile(`${p.folder}/${safeFileName(p.name)}.html`, exportPage(p.name, p.page.innerHTML), 'text/html'),
        textFile(`${p.folder}/${safeFileName(p.name)}.txt`, exportText(p.page)),
        ...p.images.map(i => i.prepared),
        ...p.files.map(f => f.prepared)
      );
    }
    transfer.status('Packing the .zip…');
    const zip = await makeZip(entries, zipName, { signal });
    await deliverFiles([zip], transfer, zipName);
  } catch (err) {
    transfer.fail(err?.name === 'AbortError' ? 'Download cancelled' : 'Download failed. Check your connection and try again.');
  }
}

function confirmDownloadData() {
  openSheet({
    title: 'Download your data',
    text: 'Every sheet, with its images and files, in one .zip, unlocked so anything can open it. Keep it somewhere safe. Recently deleted items aren’t included. Keep ScrapSheet open until it’s done.',
    actions: [
      { label: 'Download .zip', kind: 'primary', full: true, run: downloadMyData },
      { label: 'Cancel', kind: 'secondary', full: true }
    ]
  });
}

// ---- Uploads ----

// Sends one chunk with XHR so the browser reports upload progress.
function putChunk(url, blob, signal, onBytes, contentType = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    let busy = true;
    let lastActivity = Date.now();
    let restarted = false;
    const unwatch = restartIfStuck(() => busy, () => lastActivity, () => { restarted = true; xhr.abort(); });
    const end = () => {
      busy = false;
      unwatch();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once:true });
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = e => {
      lastActivity = Date.now();
      onBytes(e.loaded);
    };
    xhr.onload = () => {
      end();
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      const err = new Error(`HTTP ${xhr.status}`);
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => {
      end();
      reject(networkError());
    };
    xhr.onabort = () => {
      end();
      // Only Cancel (our signal) cancels. Phones abort uploads themselves when
      // the app goes to the background: that's a dropped connection, so the
      // piece is sent again once ScrapSheet is back.
      reject(signal?.aborted && !restarted ? abortError() : networkError());
    };
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
    err.upgrade = Boolean(data.upgrade);
    throw err;
  }
  return r.json();
}

async function uploadFile(file, targetSheet, transfer, extra = {}) {
  let id = null;
  try {
    // A new key for this file, locked with its sheet's key; the name, every
    // piece and the thumbnail are locked with it.
    const key = isLocked() ? await vault.newKey() : null;
    // Straight to R2 through the relay only when this device can reach it
    // (live sync connected); otherwise the file is stored on Netlify.
    const direct = relayUsable() ? { direct: 1 } : {};
    const meta = key
      ? { name: await vault.encryptText(key, file.name), type: await vault.encryptText(key, file.type || 'application/octet-stream'), size: file.size, enc: 1, key: await vault.wrap(key, await keyForSheet(targetSheet)), ...direct, ...extra }
      : { name: file.name, type: file.type, size: file.size, ...direct };
    const wait = why => transfer.waiting(why);
    const start = await withRetry(() => postJson(filesUrl(targetSheet, 'action=start'), meta), transfer.signal, wait);
    id = start.id;
    if (key) fileKeys.set(id, key);
    const thumbPromise = fileKind({ name: file.name, type: file.type })[0] === 'img' ? makeThumb(file) : Promise.resolve(null);
    const loaded = new Array(start.chunks).fill(0);
    const report = () => transfer.update(loaded.reduce((a, b) => a + b, 0));
    transfer.update(0);

    await runPool(start.chunks, PARALLEL_CHUNKS, async i => {
      if (transfer.signal.aborted) throw abortError();
      const plain = file.slice(i * start.chunkSize, Math.min(file.size, (i + 1) * start.chunkSize));
      const blob = key ? new Blob([await vault.encryptBytes(key, new Uint8Array(await plain.arrayBuffer()))]) : plain;
      // Straight to R2 when the server says so (start.upload), otherwise to Netlify.
      const url = start.upload ? `${start.upload.url}&i=${i}` : filesUrl(targetSheet, `id=${encodeURIComponent(id)}&chunk=${i}`);
      await withRetry(() => {
        loaded[i] = 0;
        return putChunk(url, blob, transfer.signal, n => {
          loaded[i] = n;
          report();
        }).catch(err => {
          // A piece cut off midway doesn't count until it's sent again.
          loaded[i] = 0;
          report();
          throw err;
        });
      }, transfer.signal, wait);
      loaded[i] = plain.size;
      report();
    });

    transfer.status('Finishing…');
    const thumb = await thumbPromise;
    if (thumb) await sendThumb(targetSheet, id, thumb, key);
    await withRetry(() => postJson(filesUrl(targetSheet, `id=${encodeURIComponent(id)}&action=finish`)), transfer.signal, wait);
    transfer.done(`Uploaded to ${currentSheetName(targetSheet)} · ${bytes(file.size)}`);
    return true;
  } catch (err) {
    if (id) fetch(filesUrl(targetSheet, `id=${encodeURIComponent(id)}`), { method:'DELETE' }).catch(() => {});
    if (err?.name === 'AbortError') transfer.fail('Upload cancelled');
    else if (err?.quota) transfer.fail(err.message);
    else if (err?.upgrade) {
      transfer.fail(err.message);
      showUpgrade(err.message);
    }
    else transfer.fail('Upload failed. Check your connection and retry.', () => uploadFiles([file], targetSheet));
    return false;
  }
}

function tooBigNotice(files, others) {
  const one = files.length === 1;
  openSheet({
    title: one ? 'This file is too big' : `${files.length} files are too big`,
    text: `Files can be up to ${myPlan().plan === 'free' ? `${bytes(myPlan().fileBytes)} on Free and ${bytes(MAX_FILE_BYTES)} on Pro` : `${bytes(MAX_FILE_BYTES)} each`}${one ? `, and this one is ${bytes(files[0].size)}` : ''}.${others ? ` Your other ${others === 1 ? 'file is' : 'files are'} uploading.` : ''}`,
    files,
    actions: [{ label: 'OK', kind: 'primary', full: true }]
  });
}

async function uploadFiles(files, targetSheet = activeSheet) {
  if (blockedOffline()) return;
  fileInput.value = '';
  if (!hasSheet(targetSheet)) return;
  const queue = [];
  // Over the most any plan allows: said in a box that stays until it's read
  // (a quick toast is easy to miss coming back from the phone's file picker).
  const overMax = files.filter(f => f.size > MAX_FILE_BYTES);
  files = files.filter(f => f.size <= MAX_FILE_BYTES);
  if (overMax.length) tooBigNotice(overMax, files.length);
  // Free's limits, checked here first so nothing is uploaded for nothing (the server checks too).
  const plan = myPlan();
  const tooBig = files.filter(f => f.size > plan.fileBytes && f.size <= MAX_FILE_BYTES);
  if (tooBig.length) {
    showUpgrade(`On the Free plan, files can be up to ${bytes(plan.fileBytes)}. ${tooBig.length === 1 ? `${tooBig[0].name} is` : `${tooBig.length} files are`} bigger.`);
    files = files.filter(f => !tooBig.includes(f));
  }
  if (plan.files !== null) {
    const have = [...filesCache.values()].reduce((n, list) => n + (list?.length || 0), 0);
    const room = Math.max(0, plan.files - have);
    if (files.length > room) {
      showUpgrade(`The Free plan holds ${plan.files} file${plan.files === 1 ? '' : 's'}.`);
      files = files.slice(0, room);
    }
  }
  for (const file of files) {
    queue.push({ file, transfer: createTransfer(file.name, 'Uploading', file.size, null, { note: 'Keep ScrapSheet open until uploads finish.' }) });
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

uploadBtn.addEventListener('click', () => { if (!blockedOffline()) fileInput.click(); });
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

// ---- Version history: earlier versions of a sheet's text ----
const historyModal = document.querySelector('#historyModal');
const historyBody = document.querySelector('#historyBody');

function whenLabel(at) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (diff === 0) return `Today, ${time}`;
  if (diff === 1) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

async function openHistory() {
  const sheet = activeSheet;
  const name = currentSheetName();
  rememberFocus('history');
  historyModal.querySelector('#historyTitle').textContent = `Version history · ${name}`;
  historyBody.innerHTML = '<p class="trash-empty">Loading…</p>';
  historyModal.hidden = false;
  updateModalOpen();
  historyModal.querySelector('[data-close-history]').focus();
  try {
    const r = await fetch(`${stateUrl(sheet)}&meta=versions`, { cache: 'no-store' });
    if (!r.ok) throw new Error();
    const { versions } = await r.json();
    if (!versions.length) {
      historyBody.innerHTML = '<p class="trash-empty"><strong>No earlier versions yet</strong>ScrapSheet keeps one every 10 minutes while you edit, and always before a big change like clearing the sheet.</p>';
      return;
    }
    historyBody.innerHTML = versions.map(v => `
      <div class="history-row" data-at="${v.at}">
        <div class="history-head">
          <span><span class="history-when">${escapeHtml(whenLabel(v.at))}</span> <span class="history-size">· ${escapeHtml(bytes(v.size || 0))}</span></span>
          <button class="link-btn" type="button" data-history-show="${v.at}">Show</button>
        </div>
      </div>`).join('');
    historyBody.dataset.sheet = String(sheet);
  } catch {
    historyBody.innerHTML = '<p class="trash-empty">Couldn’t load the history. Check your connection and try again.</p>';
  }
}

function closeHistory() {
  if (historyModal.hidden) return;
  historyModal.hidden = true;
  updateModalOpen();
  restoreFocus('history');
}

async function showVersion(row, at) {
  const sheet = Number(historyBody.dataset.sheet);
  const btn = row.querySelector('[data-history-show]');
  if (row.querySelector('.history-preview')) {
    row.querySelectorAll('.history-preview, .history-actions').forEach(el => el.remove());
    btn.textContent = 'Show';
    return;
  }
  btn.textContent = 'Loading…';
  try {
    const r = await fetch(`${stateUrl(sheet)}&meta=versions&at=${at}`, { cache: 'no-store' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Couldn’t open this version.');
    const html = await sheetHtml(sheet, await r.json());
    const view = cleanHtml(html);
    const images = view.querySelectorAll('img').length;
    view.querySelectorAll('img').forEach(img => img.remove());
    // Measured off-screen so line breaks come through as they look.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:-10000px;top:0;width:600px;white-space:pre-wrap';
    probe.append(view);
    document.body.append(probe);
    const text = probe.innerText;
    probe.remove();
    const preview = document.createElement('div');
    preview.className = 'history-preview';
    const words = (text || '').trim();
    preview.textContent = words ? words.slice(0, 1500) + (words.length > 1500 ? '…' : '') : 'No text';
    if (!words) preview.classList.add('empty');
    if (images) preview.textContent += `\n\n${images === 1 ? '1 image' : `${images} images`}`;
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    actions.innerHTML = '<button class="btn primary compact" type="button">Restore this version</button>';
    actions.querySelector('button').addEventListener('click', () => restoreVersion(sheet, html, at));
    row.append(preview, actions);
    btn.textContent = 'Hide';
  } catch (err) {
    btn.textContent = 'Show';
    showToast(err.message || 'Couldn’t open this version.');
  }
}

function restoreVersion(sheet, html, at) {
  if (blockedOffline()) return;
  const before = serializeEditor();
  const name = currentSheetName();
  if (!putTextBack(sheet, html)) return;
  closeHistory();
  showToast(`Restored the version from ${whenLabel(at)}`, {
    action: 'Undo',
    duration: 6000,
    run: () => { if (putTextBack(sheet, before)) showToast(`${name} is back as it was`); }
  });
}

historyModal.querySelectorAll('[data-close-history]').forEach(btn => btn.addEventListener('click', closeHistory));
historyModal.addEventListener('click', e => {
  if (e.target === historyModal) return closeHistory();
  const show = e.target.closest('[data-history-show]');
  if (show) showVersion(show.closest('.history-row'), Number(show.dataset.historyShow));
});
// Escape closes it through the page-wide handler (near the download code).

// ---- Search: sheet names, their text and file names, across every sheet ----
// Everything searched is already on this device (kept copies of each sheet
// and its file list), so typing makes no requests.

const searchModal = document.querySelector('#searchModal');
const searchInput = document.querySelector('#searchInput');
const searchResults = document.querySelector('#searchResults');
const searchBtn = document.querySelector('#searchBtn');
const plainTextCache = new Map();
let searchItems = [];
let searchActive = -1;
let searchHitTimer = null;

// Lower case, without moving any character (so positions still line up).
function foldCase(text) {
  let out = '';
  for (const ch of text) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

const tidyQuery = value => value.trim().replace(/\s+/g, ' ');

// The text of an editor or stored sheet as one string, line breaks as \n,
// with where each piece of text starts (to highlight a match later).
function textIndex(root) {
  let text = '';
  const parts = [];
  const blocks = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TR)$/;
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push({ node: child, start: text.length });
        text += child.data;
      } else if (child.nodeName === 'BR') {
        text += '\n';
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const block = blocks.test(child.nodeName);
        if (block && text && !text.endsWith('\n')) text += '\n';
        walk(child);
        if (block && text && !text.endsWith('\n')) text += '\n';
      }
    }
  };
  walk(root);
  return { text, parts };
}

function sheetPlainText(id) {
  if (id === activeSheet && !pad.classList.contains('is-loading')) return textIndex(pad).text;
  const cached = sheetCache.get(id);
  if (!cached) return null;
  const known = plainTextCache.get(id);
  if (known?.html === cached.html) return known.text;
  // An inert copy: read this way, no images load.
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${cached.html}`, 'text/html');
  const text = textIndex(doc.body).text;
  plainTextCache.set(id, { html: cached.html, text });
  return text;
}

function sheetFilesFor(id) {
  const list = id === activeSheet && (currentFiles.length || !emptyFiles.hidden) ? currentFiles : filesCache.get(id) || [];
  return list.filter(f => !pendingDeletes.has(f.id));
}

function findMatches(query) {
  const q = foldCase(query);
  const named = [];
  const texts = [];
  const files = [];
  for (const sheet of sheets) {
    if (foldCase(sheet.name).includes(q)) named.push({ kind: 'sheet', sheet: sheet.id });
    const text = sheetPlainText(sheet.id);
    if (text) {
      const low = foldCase(text);
      const hits = [];
      for (let at = low.indexOf(q); at !== -1 && hits.length < 100; at = low.indexOf(q, at + q.length)) hits.push(at);
      hits.slice(0, 3).forEach((at, n) => texts.push({ kind: 'text', sheet: sheet.id, at, n, text, more: n === 2 ? hits.length - 3 : 0 }));
    }
    for (const file of sheetFilesFor(sheet.id)) {
      if (foldCase(file.name).includes(q)) files.push({ kind: 'file', sheet: sheet.id, file });
    }
  }
  return [...named, ...texts, ...files].slice(0, 80);
}

// Escaped text with every match of the query marked.
function markHtml(text, query) {
  const low = foldCase(text);
  const q = foldCase(query);
  let html = '';
  let from = 0;
  for (let at = low.indexOf(q); at !== -1 && q; at = low.indexOf(q, from)) {
    html += escapeHtml(text.slice(from, at)) + `<mark>${escapeHtml(text.slice(at, at + q.length))}</mark>`;
    from = at + q.length;
  }
  return html + escapeHtml(text.slice(from));
}

function snippetHtml(text, at, length, query) {
  let start = Math.max(0, at - 40);
  if (start > 0) {
    const gap = text.slice(start, at).search(/\s/);
    if (gap !== -1) start += gap + 1;
  }
  const end = Math.min(text.length, at + length + 100);
  const piece = text.slice(start, end).replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '') + markHtml(piece, query) + (end < text.length ? '…' : '');
}

function sheetSummary(id) {
  const { content, files } = statusFor(id);
  const parts = [content ? 'Has text' : files ? '' : 'Empty', files ? `${files} file${files === 1 ? '' : 's'}` : ''].filter(Boolean);
  return parts.join(' · ');
}

function renderSearch() {
  const query = tidyQuery(searchInput.value);
  searchActive = -1;
  searchInput.removeAttribute('aria-activedescendant');
  if (!query) {
    searchItems = [];
    const tip = matchMedia('(hover: hover) and (pointer: fine)').matches ? '<br>Press <kbd>/</kbd> or <kbd>Ctrl K</kbd> to search from anywhere.' : '';
    searchResults.innerHTML = `<p class="search-empty">Search the text and file names in all your sheets.${tip}</p>`;
    return;
  }
  searchItems = findMatches(query);
  if (!searchItems.length) {
    searchResults.innerHTML = `<p class="search-empty">No matches for “${escapeHtml(query)}”.</p>`;
    return;
  }
  const groups = { sheet: 'Sheets', text: 'In text', file: 'Files' };
  let last = '';
  searchResults.innerHTML = searchItems.map((item, i) => {
    const group = item.kind !== last ? `<div class="search-group" role="presentation">${groups[item.kind]}</div>` : '';
    last = item.kind;
    const name = currentSheetName(item.sheet);
    let mark;
    let body;
    if (item.kind === 'sheet') {
      mark = `<span class="search-mark" aria-hidden="true">${icon('lines')}</span>`;
      body = `<div class="search-title">${markHtml(name, query)}</div><div class="search-meta">${escapeHtml(sheetSummary(item.sheet))}</div>`;
    } else if (item.kind === 'text') {
      mark = `<span class="search-mark" aria-hidden="true">${icon('lines')}</span>`;
      const more = item.more ? ` · ${item.more} more in this sheet` : '';
      body = `<div class="search-meta">${escapeHtml(name)}${more}</div><div class="search-snippet">${snippetHtml(item.text, item.at, query.length, query)}</div>`;
    } else {
      mark = fileIconHtml(item.file);
      body = `<div class="search-title">${markHtml(item.file.name, query)}</div><div class="search-meta">${escapeHtml(name)} · ${bytes(item.file.size || 0)}</div>`;
    }
    return `${group}<div class="search-item" role="option" id="search-opt-${i}" data-i="${i}" aria-selected="false">${mark}<div class="search-main">${body}</div></div>`;
  }).join('');
  setSearchActive(0);
  fillThumbs(searchResults);
}

function setSearchActive(i) {
  if (!searchItems.length) return;
  searchActive = (i + searchItems.length) % searchItems.length;
  for (const el of searchResults.querySelectorAll('.search-item')) {
    const on = Number(el.dataset.i) === searchActive;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
    if (on) el.scrollIntoView({ block: 'nearest' });
  }
  searchInput.setAttribute('aria-activedescendant', `search-opt-${searchActive}`);
}

function openSearch() {
  if (!appStarted || !searchModal.hidden) return;
  closeMenu({ focusTrigger: false });
  rememberFocus('search');
  searchModal.hidden = false;
  updateModalOpen();
  searchInput.focus();
  searchInput.select();
  renderSearch();
}

function closeSearch({ restore = true } = {}) {
  if (searchModal.hidden) return;
  searchModal.hidden = true;
  updateModalOpen();
  if (restore) restoreFocus('search');
  else returnFocusTo.delete('search');
}

async function openSearchResult(item) {
  const query = tidyQuery(searchInput.value);
  closeSearch({ restore: false });
  if (selecting) setSelecting(false);
  if (item.sheet !== activeSheet) {
    await switchSheet(item.sheet);
    // Still on the old sheet: an unsaved edit there couldn't be saved.
    if (activeSheet !== item.sheet) return;
  }
  if (item.kind === 'text') showTextMatch(query, item.n);
  else if (item.kind === 'file') showFileRow(item.file.id);
  else window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

// Highlights the nth match in the editor (without opening the keyboard) and scrolls to it.
function showTextMatch(query, n) {
  const { text, parts } = textIndex(pad);
  const low = foldCase(text);
  const q = foldCase(query);
  let at = -1;
  for (let i = 0, from = 0; i <= n; i++) {
    const next = low.indexOf(q, from);
    if (next === -1) break;
    at = next;
    from = next + q.length;
  }
  const end = at + q.length;
  const first = parts.find(p => at >= p.start && at < p.start + p.node.data.length);
  const last = parts.find(p => end > p.start && end <= p.start + p.node.data.length);
  if (at === -1 || !first || !last) {
    padCard.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  const range = document.createRange();
  range.setStart(first.node, at - first.start);
  range.setEnd(last.node, end - last.start);
  if (window.CSS?.highlights && window.Highlight) {
    CSS.highlights.set('search-hit', new Highlight(range));
    clearTimeout(searchHitTimer);
    searchHitTimer = setTimeout(clearSearchHit, 8000);
  } else {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const rect = range.getBoundingClientRect();
  window.scrollTo({ top: Math.max(0, scrollY + rect.top - innerHeight * 0.35), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function clearSearchHit() {
  clearTimeout(searchHitTimer);
  window.CSS?.highlights?.delete('search-hit');
}

function showFileRow(id) {
  const row = fileList.querySelector(`.file-row[data-id="${CSS.escape(id)}"]`);
  if (!row) {
    filesSection.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  row.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 2400);
  row.querySelector('.file-name')?.focus({ preventScroll: true });
}

pad.addEventListener('input', clearSearchHit);
pad.addEventListener('pointerdown', clearSearchHit);
searchBtn.addEventListener('click', openSearch);
document.querySelector('#searchCloseBtn').addEventListener('click', () => closeSearch());
searchModal.addEventListener('click', e => { if (e.target === searchModal) closeSearch(); });
searchInput.addEventListener('input', renderSearch);
searchInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    setSearchActive(searchActive + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (searchItems[searchActive]) openSearchResult(searchItems[searchActive]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSearch();
  }
});
searchResults.addEventListener('click', e => {
  const el = e.target.closest('.search-item');
  if (el) openSearchResult(searchItems[Number(el.dataset.i)]);
});

// Ctrl K / ⌘K anywhere, or / when not typing.
document.addEventListener('keydown', e => {
  if (!appStarted || document.querySelector('.modal-backdrop:not([hidden])')) return;
  const typing = e.target.closest?.('input, textarea, [contenteditable="true"]');
  if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey)) {
    e.preventDefault();
    openSearch();
  }
});

// ---- Recently Deleted: sheets and files kept 30 days before going for good ----

const trashModal = document.querySelector('#trashModal');
const trashBody = document.querySelector('#trashBody');
const trashFoot = document.querySelector('#trashFoot');
const trashEmptyBtn = document.querySelector('#trashEmptyBtn');
let trashData = null;

async function trashPost(body) {
  const r = await fetch(`${API_STATE}?meta=trash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

async function openTrash() {
  rememberFocus('trash');
  trashModal.hidden = false;
  updateModalOpen();
  trashModal.querySelector('[data-close-trash]').focus({ preventScroll: true });
  trashBody.innerHTML = '<p class="trash-empty">Loading…</p>';
  trashFoot.hidden = true;
  await loadTrash();
}

function closeTrash() {
  if (trashModal.hidden) return;
  trashModal.hidden = true;
  updateModalOpen();
  restoreFocus('trash');
}

async function loadTrash() {
  try {
    const r = await fetch(`${API_STATE}?meta=trash`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    trashData = await r.json();
    trashData.sheets = await Promise.all((trashData.sheets || []).map(async t => {
      if (!t.key || !masterKey) return t;
      try {
        return { ...t, name: await vault.decryptText(await vault.unwrap(t.key, masterKey), t.name) };
      } catch {
        return { ...t, name: 'Locked sheet' };
      }
    }));
    const bySheet = new Map();
    for (const f of trashData.files || []) bySheet.set(f.sheet, [...(bySheet.get(f.sheet) || []), f]);
    const opened = (await Promise.all([...bySheet].map(([sheet, list]) => openFiles(list, sheet)))).flat();
    const names = new Map(opened.map(f => [f.id, f.name]));
    trashData.files = (trashData.files || []).map(f => ({ ...f, name: names.get(f.id) ?? f.name, sheetName: currentSheetName(f.sheet) }));
    renderTrash();
  } catch {
    trashBody.innerHTML = '<p class="trash-empty">Couldn’t load Recently Deleted. Check your connection and try again.</p>';
  }
}

function trashWhen(item) {
  const days = trashData?.days || 30;
  const left = Math.max(0, Math.ceil((item.deletedAt + days * 86_400_000 - Date.now()) / 86_400_000));
  const leftText = left <= 1 ? 'Goes within a day' : `${left} days left`;
  const deleted = escapeHtml(`Deleted ${new Date(item.deletedAt).toLocaleString()}`);
  return `<span title="${deleted}"${left <= 3 ? ' class="soon"' : ''}>${leftText}</span>`;
}

function renderTrash() {
  const gone = trashData?.sheets || [];
  const files = trashData?.files || [];
  trashFoot.hidden = !gone.length && !files.length;
  if (!gone.length && !files.length) {
    trashBody.innerHTML = '<div class="trash-empty"><strong>Nothing here</strong>Deleted sheets and files stay here for 30 days, then they’re deleted for good.</div>';
    keepFocusInTrash();
    return;
  }
  let html = '';
  if (gone.length) {
    html += '<div class="trash-group">Sheets</div>' + gone.map(s => {
      const name = escapeHtml(s.name);
      const holds = s.files ? `${s.files} file${s.files === 1 ? '' : 's'} · ${bytes(s.bytes)}` : 'No files';
      return `<div class="trash-row">
        <span class="search-mark" aria-hidden="true">${icon('lines')}</span>
        <div class="search-main"><div class="trash-name" title="${name}">${name}</div><div class="trash-meta">${holds}</div><div class="trash-meta">${trashWhen(s)}</div></div>
        <button class="link-btn" type="button" data-restore-sheet="${s.id}">Restore</button>
        <button class="icon-btn" type="button" data-delete-sheet="${s.id}" aria-label="Delete ${name} for good" title="Delete for good">${icon('trash')}</button>
      </div>`;
    }).join('');
  }
  if (files.length) {
    html += '<div class="trash-group">Files</div>' + files.map((f, i) => {
      const name = escapeHtml(f.name);
      return `<div class="trash-row">
        ${fileIconHtml(f)}
        <div class="search-main"><div class="trash-name" title="${name}">${name}</div><div class="trash-meta">${escapeHtml(f.sheetName)} · ${bytes(f.size || 0)}</div><div class="trash-meta">${trashWhen(f)}</div></div>
        <button class="link-btn" type="button" data-restore-file="${i}">Restore</button>
        <button class="icon-btn" type="button" data-delete-file="${i}" aria-label="Delete ${name} for good" title="Delete for good">${icon('trash')}</button>
      </div>`;
    }).join('');
  }
  trashBody.innerHTML = html;
  fillThumbs(trashBody);
  keepFocusInTrash();
}

// A redraw can remove the button that had focus; keep focus inside the panel.
function keepFocusInTrash() {
  if (!trashModal.hidden && !trashModal.contains(document.activeElement)) {
    (trashBody.querySelector('button') || trashModal.querySelector('[data-close-trash]')).focus({ preventScroll: true });
  }
}

// File lists for one sheet, after something came back or went for good.
async function refreshFilesFor(sheet) {
  if (sheet === activeSheet) return loadFiles(true, sheet);
  try {
    const r = await fetch(filesUrl(sheet), { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    filesCache.set(sheet, await openFiles(Array.isArray(data.files) ? data.files : [], sheet));
    scheduleTabStatus();
  } catch {
    filesCache.delete(sheet);
  }
}

async function restoreSheet(id, { open = true } = {}) {
  try {
    const data = await trashPost({ action: 'restore-sheet', sheet: id });
    applySheets(await openSheetList(data));
    prefetchSheets();
    showToast(`Restored ${currentSheetName(id)}`);
    if (open) await switchSheet(id);
    return true;
  } catch (err) {
    showToast(err.message);
    return false;
  }
}

async function restoreFiles(files) {
  if (blockedOffline()) return;
  const results = await Promise.all(files.map(f => trashPost({ action: 'restore-file', sheet: f.sheet, id: f.id }).then(() => true, () => false)));
  await Promise.all([...new Set(files.map(f => f.sheet))].map(refreshFilesFor));
  const failed = results.filter(ok => !ok).length;
  showToast(failed ? `${failed} file${failed === 1 ? '' : 's'} couldn’t be restored` : files.length === 1 ? `Restored ${files[0].name}` : `Restored ${files.length} files`);
  return !failed;
}

trashBody.addEventListener('click', async e => {
  if (e.target.closest('button') && blockedOffline()) return;
  const btn = e.target.closest('button');
  if (!btn || !trashData) return;
  const fileAt = i => trashData.files[Number(i)];
  if (btn.dataset.restoreSheet) {
    btn.disabled = true;
    if (await restoreSheet(Number(btn.dataset.restoreSheet), { open: false })) await loadTrash();
    else btn.disabled = false;
  } else if (btn.dataset.restoreFile) {
    btn.disabled = true;
    if (await restoreFiles([fileAt(btn.dataset.restoreFile)])) await loadTrash();
    else btn.disabled = false;
  } else if (btn.dataset.deleteSheet || btn.dataset.deleteFile) {
    const sheet = btn.dataset.deleteSheet ? trashData.sheets.find(s => s.id === Number(btn.dataset.deleteSheet)) : null;
    const file = btn.dataset.deleteFile ? fileAt(btn.dataset.deleteFile) : null;
    openSheet({
      title: `Delete ${sheet ? sheet.name : file.name} for good?`,
      text: sheet ? 'Its text and files will be gone from all your devices. This can’t be undone.' : 'It will be gone from all your devices. This can’t be undone.',
      files: file ? [file] : [],
      actions: [
        { label: 'Cancel', kind: 'secondary' },
        {
          label: 'Delete for good',
          kind: 'danger-solid',
          run: async () => {
            try {
              await trashPost(sheet ? { action: 'delete-sheet', sheet: sheet.id } : { action: 'delete-file', sheet: file.sheet, id: file.id });
              showToast('Deleted for good');
              loadUsage();
              await loadTrash();
            } catch (err) {
              showToast(err.message);
            }
          }
        }
      ]
    });
  }
});

trashEmptyBtn.addEventListener('click', () => {
  if (blockedOffline()) return;
  const n = (trashData?.sheets?.length || 0) + (trashData?.files?.length || 0);
  openSheet({
    title: 'Empty Recently Deleted?',
    text: `${n} item${n === 1 ? '' : 's'} will be deleted for good on all your devices. This can’t be undone.`,
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      {
        label: 'Empty Recently Deleted',
        kind: 'danger-solid',
        run: async () => {
          try {
            await trashPost({ action: 'empty' });
            showToast('Recently Deleted is empty');
            loadUsage();
            await loadTrash();
          } catch (err) {
            showToast(err.message);
          }
        }
      }
    ]
  });
});

trashModal.querySelector('[data-close-trash]').addEventListener('click', closeTrash);
trashModal.addEventListener('click', e => { if (e.target === trashModal) closeTrash(); });

// ---- Share links: a file or a sheet, for anyone with the link, until it expires ----

const API_SHARE = '/.netlify/functions/share';
const shareModal = document.querySelector('#shareModal');
const shareBody = document.querySelector('#shareBody');
const linksBody = document.querySelector('#linksBody');
const SHARE_DAYS = [[1, '1 day'], [7, '7 days'], [30, '30 days']];
let shareTarget = null;
let shareLink = null;

function shareKey(kind, sheet, file = null) {
  return `${kind}:${sheet}:${file || ''}`;
}
// Each link carries the shared item's key after "#": browsers never send that
// part to the server, so only someone holding the whole link can open it.
const shareFragments = new Map();
const shareUrl = share => `${location.origin}/s/${share.token}${shareFragments.has(share.token) ? `#${shareFragments.get(share.token)}` : ''}`;

// Links with their item's key worked out, and their names unlocked.
async function openShareLinks(list) {
  return Promise.all(list.map(async s => {
    if (!masterKey) return s;
    try {
      let key;
      if (s.kind === 'sheet') {
        key = await keyForSheet(s.sheet);
      } else {
        const file = knownFiles.get(s.file);
        if (!file?.enc) return s;
        key = await fileKeyFor(file, s.sheet);
      }
      shareFragments.set(s.token, await vault.exportKey(key));
      return { ...s, name: await vault.decryptText(key, s.name) };
    } catch {
      return s;
    }
  }));
}

function setLiveShares(list) {
  liveShares = new Map(list.filter(s => s.expiresAt > Date.now() && !s.revoked).map(s => [shareKey(s.kind, s.sheet, s.file), s]));
}

function liveShareFor(kind, sheet, file = null) {
  const share = liveShares.get(shareKey(kind, sheet, file));
  return share && share.expiresAt > Date.now() ? share : null;
}

// Forget or remember one link locally, then redraw what shows it.
function noteShare(share) {
  const key = shareKey(share.kind, share.sheet, share.file);
  if (share.state === 'on') liveShares.set(key, share);
  else if (liveShares.get(key)?.token === share.token) liveShares.delete(key);
  if (share.kind === 'file' && share.sheet === activeSheet) renderFiles();
}

function untilText(at) {
  const ms = at - Date.now();
  if (ms <= 0) return 'Expired';
  const hours = ms / 3_600_000;
  if (hours < 1) return `Expires in ${Math.max(1, Math.round(ms / 60000))} min`;
  if (hours < 20) return `Expires in ${Math.round(hours)} h`;
  const days = Math.max(1, Math.round(hours / 24));
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

const viewsText = n => n ? `Opened ${n} time${n === 1 ? '' : 's'}` : 'Not opened yet';

async function sharePost(body) {
  const r = await fetch(API_SHARE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (data.upgrade) showUpgrade(data.error);
    throw new Error(data.error || 'Something went wrong. Try again.');
  }
  return data;
}

async function fetchMyShares() {
  const r = await fetch(`${API_SHARE}?mine=1`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const shares = await openShareLinks((await r.json()).shares);
  setLiveShares(shares.filter(s => s.state === 'on'));
  if (activeSheet) renderFiles();
  return shares;
}

function segHtml(selected) {
  return `<div class="seg" role="radiogroup" aria-label="Link expires after">${SHARE_DAYS.map(([days, label]) =>
    `<button type="button" role="radio" data-days="${days}" aria-checked="${days === selected}">${label}</button>`).join('')}</div>`;
}

async function openShare(target) {
  if (blockedOffline()) return;
  if (!myPlan().share) {
    showUpgrade('Share links are part of Pro.');
    return;
  }
  shareTarget = target;
  shareLink = null;
  rememberFocus('share');
  shareModal.querySelector('#shareKicker').textContent = target.kind === 'sheet' ? 'Share sheet' : 'Share file';
  shareModal.querySelector('#shareTitle').textContent = target.name;
  shareBody.innerHTML = '<p class="share-explain">Loading…</p>';
  shareModal.hidden = false;
  updateModalOpen();
  shareModal.querySelector('[data-close-share]').focus({ preventScroll: true });
  try {
    const shares = await fetchMyShares();
    shareLink = shares.find(s => s.state === 'on' && shareKey(s.kind, s.sheet, s.file) === shareKey(target.kind, target.sheet, target.file)) || null;
  } catch {
    shareLink = liveShareFor(target.kind, target.sheet, target.file);
  }
  renderShare();
}

function closeShare() {
  if (shareModal.hidden) return;
  shareModal.hidden = true;
  updateModalOpen();
  restoreFocus('share');
}

function renderShare(focus) {
  const what = shareTarget.kind === 'sheet' ? 'this sheet’s text, images and files' : 'this file';
  if (!shareLink) {
    shareBody.innerHTML = `
      <p class="share-explain">Anyone with the link can view and download ${what}. They don’t need an account.</p>
      <p class="seg-label" id="shareDaysLabel">Link expires after</p>
      ${segHtml(7)}
      <button class="btn full" type="button" data-share-create>${icon('link')}Create link</button>`;
    if (focus) shareBody.querySelector('[data-share-create]').focus({ preventScroll: true });
    return;
  }
  const canShare = typeof navigator.share === 'function';
  const phone = canShare && phoneShare();
  shareBody.innerHTML = `
    ${phone ? `<button class="btn full share-send-main" type="button" data-share-send>${icon('share')}Share…</button>` : ''}
    <div>
      <label class="field-label" for="shareUrlInput">Link</label>
      <div class="share-url-row">
        <input id="shareUrlInput" type="text" readonly value="${escapeHtml(shareUrl(shareLink))}" />
        <button class="btn compact${phone ? ' secondary' : ''}" type="button" data-share-copy>Copy</button>
      </div>
    </div>
    ${canShare && !phone ? `<button class="btn secondary full" type="button" data-share-send>${icon('share')}Share…</button>` : ''}
    <p class="share-status"><b>${escapeHtml(untilText(shareLink.expiresAt))}</b> · ${escapeHtml(viewsText(shareLink.views || 0))}</p>
    <p class="seg-label">Change to expire after (from now)</p>
    ${segHtml(0)}
    <div class="share-actions">
      <span class="share-status">Anyone with the link can open ${what}.</span>
      <button class="link-btn share-off" type="button" data-share-revoke>Turn off link</button>
    </div>`;
  if (focus) shareBody.querySelector(phone ? '[data-share-send]' : '[data-share-copy]').focus({ preventScroll: true });
}

// Phones and tablets: the system share menu (Messages, Mail, AirDrop, WhatsApp…)
// comes first; computers lead with Copy.
function phoneShare() {
  return typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches;
}

// Opens the system share menu. Some phones refuse when it isn't straight
// after a tap (say, after waiting for a new link); the Share… button is then
// one tap away. Returns false if the menu didn't open.
async function shareNatively(url, title) {
  try {
    await navigator.share({ title, url });
    return true;
  } catch (err) {
    // Closing the menu without sharing is fine; anything else means it didn't open.
    return err?.name === 'AbortError';
  }
}

async function copyLink(url, input) {
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied');
  } catch {
    input?.select();
    showToast('Selected: copy it from the box');
  }
}

shareBody.addEventListener('click', async e => {
  const btn = e.target.closest('button');
  if (!btn || !shareTarget) return;
  if (btn.dataset.days) {
    const days = Number(btn.dataset.days);
    btn.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b === btn)));
    if (shareLink) {
      try {
        const { share } = await sharePost({ action: 'extend', token: shareLink.token, days });
        shareLink = (await openShareLinks([share]))[0];
        noteShare(share);
        renderShare();
        showToast(`Link now expires in ${days} day${days === 1 ? '' : 's'}`);
      } catch (err) {
        showToast(err.message);
      }
    }
  } else if ('shareCreate' in btn.dataset) {
    const days = Number(shareBody.querySelector('.seg [aria-checked="true"]')?.dataset.days || 7);
    btn.disabled = true;
    try {
      const { share: made } = await sharePost({ action: 'create', kind: shareTarget.kind, sheet: shareTarget.sheet, file: shareTarget.file, days });
      const [share] = await openShareLinks([made]);
      shareLink = share;
      noteShare(share);
      renderShare(true);
      if (phoneShare()) {
        if (!(await shareNatively(shareUrl(share), shareTarget.name))) showToast('Link ready: tap Share… to send it');
      } else {
        copyLink(shareUrl(share), shareBody.querySelector('#shareUrlInput'));
      }
    } catch (err) {
      btn.disabled = false;
      showToast(err.message);
    }
  } else if ('shareCopy' in btn.dataset) {
    copyLink(shareUrl(shareLink), shareBody.querySelector('#shareUrlInput'));
  } else if ('shareSend' in btn.dataset) {
    if (!(await shareNatively(shareUrl(shareLink), shareTarget.name))) copyLink(shareUrl(shareLink), shareBody.querySelector('#shareUrlInput'));
  } else if ('shareRevoke' in btn.dataset) {
    try {
      const { share } = await sharePost({ action: 'revoke', token: shareLink.token });
      noteShare(share);
      shareLink = null;
      renderShare(true);
      showToast('Link turned off');
    } catch (err) {
      showToast(err.message);
    }
  }
});

// Arrow keys move between the expiry choices.
shareBody.addEventListener('keydown', e => {
  const btn = e.target.closest('.seg button');
  if (!btn || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  const all = [...btn.parentElement.querySelectorAll('button')];
  const next = all[(all.indexOf(btn) + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length];
  next.focus();
  next.click();
});

shareModal.querySelector('[data-close-share]').addEventListener('click', closeShare);
shareModal.addEventListener('click', e => { if (e.target === shareModal) closeShare(); });

// ---- Files & share links: every file across the sheets, storage, and every share link ----
// All of it comes from this account's own endpoints (the server checks the
// session on each), and file names are unlocked here on the device.

const libraryModal = document.querySelector('#libraryModal');
const libStorage = document.querySelector('#libStorage');
const libSearch = document.querySelector('#libSearch');
const libFilesBody = document.querySelector('#libFilesBody');
const libTabs = [...libraryModal.querySelectorAll('[data-lib-tab]')];
let linksList = [];
let libraryItems = [];
let libraryFromProfile = false;
let libraryLoad = 0;

const FILE_TYPES = { img: 'Image', pdf: 'PDF', sheet: 'Spreadsheet', doc: 'Document', slides: 'Slides', zip: 'Archive', video: 'Video', audio: 'Audio', text: 'Text' };
function fileTypeLabel(f) {
  const [kind, label] = fileKind(f);
  return FILE_TYPES[kind] || (label && label !== 'FILE' ? `${label} file` : 'File');
}

async function openLibrary(tab = 'files', { fromProfile = false } = {}) {
  libraryFromProfile = fromProfile;
  if (libraryModal.hidden) rememberFocus('library');
  libraryModal.hidden = false;
  updateModalOpen();
  libSearch.value = '';
  showInactiveLinks = false;
  selectLibraryTab(tab, { focus: true });
  loadLibraryFiles();
  loadLinks();
}

function openLinks() {
  return openLibrary('links');
}

function closeLibrary({ back = false } = {}) {
  if (libraryModal.hidden) return;
  libraryModal.hidden = true;
  updateModalOpen();
  if (back && libraryFromProfile) {
    returnFocusTo.delete('library');
    openProfile('main', { focusRow: 'library' });
    return;
  }
  restoreFocus('library');
}

function selectLibraryTab(tab, { focus = false } = {}) {
  for (const btn of libTabs) {
    const on = btn.dataset.libTab === tab;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    document.querySelector(`#${btn.getAttribute('aria-controls')}`).hidden = !on;
    if (on && focus) btn.focus({ preventScroll: true });
  }
}

libTabs.forEach(btn => btn.addEventListener('click', () => selectLibraryTab(btn.dataset.libTab)));
libraryModal.querySelector('[role="tablist"]').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const i = libTabs.findIndex(b => b.getAttribute('aria-selected') === 'true');
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? libTabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + libTabs.length) % libTabs.length;
  selectLibraryTab(libTabs[next].dataset.libTab, { focus: true });
});

// Fresh lists for every sheet (the open one is already current).
async function loadAllSheetFiles() {
  await Promise.all(sheets.filter(s => s.id !== activeSheet).map(async s => {
    try {
      const r = await fetch(filesUrl(s.id), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      filesCache.set(s.id, await openFiles(Array.isArray(data.files) ? data.files : [], s.id));
    } catch {
      // Shows what this device already has for that sheet.
    }
  }));
  return sheets.flatMap(s => sheetFilesFor(s.id).map(file => ({ file, sheet: s })));
}

async function loadUsageNumbers() {
  const r = await fetch(`${API_STATE}?meta=usage`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadLibraryFiles() {
  const load = ++libraryLoad;
  if (!libraryItems.length) libFilesBody.innerHTML = '<p class="lib-empty">Loading…</p>';
  const [items, usage] = await Promise.all([loadAllSheetFiles(), loadUsageNumbers().catch(() => null)]);
  if (load !== libraryLoad || libraryModal.hidden) return;
  libraryItems = items;
  renderStorage(usage);
  renderLibraryFiles();
}

function renderStorage(usage) {
  if (!usage) {
    libStorage.innerHTML = '<p class="lib-storage-text">Storage use isn’t available right now.</p>';
    return;
  }
  const { bytes: used, quota } = usage;
  const share = quota ? Math.min(1, used / quota) : 0;
  const state = share >= 1 ? ' full' : share >= 0.8 ? ' near' : '';
  const plan = myPlan();
  libStorage.innerHTML = `
    <div class="lib-storage-top">
      <span class="lib-storage-label">Storage</span>
      <span class="lib-storage-text${state}"><strong>${escapeHtml(bytes(used))}</strong> of ${quota ? escapeHtml(bytes(quota)) : 'no limit'} used</span>
    </div>
    ${quota ? `<div class="lib-bar${state}" role="progressbar" aria-label="Storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(share * 100)}"><span></span></div>` : ''}
    <p class="lib-storage-hint">${escapeHtml(plan.name || 'Pro')} plan · includes files in Recently Deleted${plan.plan === 'free' ? ' · <button class="link-btn lib-upgrade" type="button" data-lib-upgrade>Upgrade to Pro</button>' : ''}</p>`;
  const fill = libStorage.querySelector('.lib-bar span');
  if (fill) fill.style.width = `${Math.max(share * 100, used > 0 ? 1.5 : 0)}%`;
}

function renderLibraryFiles() {
  const q = foldCase(libSearch.value.trim());
  const list = libraryItems
    .filter(({ file }) => !q || foldCase(file.name).includes(q))
    .sort((a, b) => (b.file.uploadedAt || 0) - (a.file.uploadedAt || 0));
  if (!libraryItems.length) {
    libFilesBody.innerHTML = '<div class="lib-empty"><strong>No files yet</strong>Drop files into any sheet, or use Add files. They all show up here.</div>';
    return;
  }
  if (!list.length) {
    libFilesBody.innerHTML = `<div class="lib-empty"><strong>No matches</strong>No files match “${escapeHtml(libSearch.value.trim())}”.</div>`;
    return;
  }
  const rows = list.map(({ file, sheet }) => {
    const i = libraryItems.findIndex(x => x.file === file);
    const name = escapeHtml(file.name);
    const type = escapeHtml(fileTypeLabel(file));
    const size = escapeHtml(bytes(file.size || 0));
    const where = escapeHtml(sheet.name);
    return `<tr>
      <td class="lib-name-cell"><div class="lib-name-wrap">${fileIconHtml({ ...file, thumb: null })}<div class="lib-name-text"><span class="lib-name">${name}</span><span class="lib-sub">${type} · ${size} · ${where}</span></div></div></td>
      <td class="lib-col">${type}</td>
      <td class="lib-col lib-num">${size}</td>
      <td class="lib-col"><span class="lib-sheet">${where}</span></td>
      <td class="lib-actions"><button class="link-btn" type="button" data-lib-open="${sheet.id}" data-lib-file="${escapeHtml(file.id)}">Open sheet</button><button class="icon-btn" type="button" data-lib-menu="${i}" aria-label="More actions for ${name}" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button></td>
    </tr>`;
  }).join('');
  libFilesBody.innerHTML = `<table class="lib-table">
    <caption class="sr-only">Your files</caption>
    <thead><tr><th scope="col">Name</th><th scope="col" class="lib-col">Type</th><th scope="col" class="lib-col lib-num">Size</th><th scope="col" class="lib-col">Sheet</th><th scope="col" class="lib-actions"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="lib-count">${list.length} file${list.length === 1 ? '' : 's'}${q ? ` matching “${escapeHtml(libSearch.value.trim())}”` : ` in ${new Set(libraryItems.map(x => x.sheet.id)).size} sheet${new Set(libraryItems.map(x => x.sheet.id)).size === 1 ? '' : 's'}`}</p>`;
}

libSearch.addEventListener('input', renderLibraryFiles);

// The file's sheet, with the file brought into view.
async function openFileInSheet(sheetId, fileId) {
  closeLibrary();
  if (sheetId !== activeSheet) await switchSheet(sheetId);
  for (let i = 0; i < 20; i++) {
    const row = fileList.querySelector(`.file-row[data-id="${CSS.escape(fileId)}"]`);
    if (row) {
      row.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1600);
      row.querySelector('.file-name')?.focus({ preventScroll: true });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

// Something changed a file from here (deleted, kept): show it.
function libraryChanged() {
  if (!libraryModal.hidden) setTimeout(loadLibraryFiles, 300);
}

libFilesBody.addEventListener('click', e => {
  const open = e.target.closest('[data-lib-open]');
  if (open) return openFileInSheet(Number(open.dataset.libOpen), open.dataset.libFile);
  const more = e.target.closest('[data-lib-menu]');
  if (more) {
    const item = libraryItems[Number(more.dataset.libMenu)];
    if (item) openFileMenu(more, item.file);
  }
});

libStorage.addEventListener('click', e => {
  if (e.target.closest('[data-lib-upgrade]')) showUpgrade('');
});

async function loadLinks() {
  if (!linksList.length) linksBody.innerHTML = '<p class="lib-empty">Loading…</p>';
  try {
    linksList = await fetchMyShares();
    renderLinks();
  } catch {
    linksBody.innerHTML = '<p class="lib-empty">Couldn’t load your links. Check your connection and try again.</p>';
  }
}

let showInactiveLinks = false;

const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

// Why a link stopped working, in words.
function endedText(s) {
  const when = s.endedAt ? ` · ${shortDate(s.endedAt)}` : '';
  if (s.state === 'expired' || s.reason === 'expired') return `Expired${when}`;
  return ({
    you: 'Turned off by you',
    replaced: 'Replaced by a newer link',
    admin: 'Turned off when the account was deactivated',
    encryption: 'Turned off when encryption was set up'
  }[s.reason] || 'Turned off') + when;
}

function linkRows(list) {
  return list.map(({ s, i }) => {
    const on = s.state === 'on';
    const name = escapeHtml(s.name);
    const kind = s.kind === 'sheet' ? 'Sheet' : 'File';
    const where = escapeHtml(hasSheet(s.sheet) ? currentSheetName(s.sheet) : 'Deleted sheet');
    const status = escapeHtml(on ? `${untilText(s.expiresAt)} · ${viewsText(s.views)}` : endedText(s));
    const mark = `<span class="search-mark" aria-hidden="true">${icon(s.kind === 'sheet' ? 'lines' : 'link')}</span>`;
    const actions = on
      ? `<button class="link-btn" type="button" data-link-copy="${i}">${phoneShare() ? 'Share' : 'Copy'}</button><button class="icon-btn lib-danger" type="button" data-link-off="${i}" aria-label="Turn off the link to ${name}" title="Turn off link">${icon('trash')}</button>`
      : '';
    return `<tr class="${on ? '' : 'lib-ended'}">
      <td class="lib-name-cell"><div class="lib-name-wrap">${mark}<div class="lib-name-text"><span class="lib-name">${name}</span><span class="lib-sub">${kind}${s.kind === 'file' ? ` in ${where}` : ''} · <span class="lib-state${on ? '' : ' off'}">${status}</span></span></div></div></td>
      <td class="lib-col">${kind}</td>
      <td class="lib-col"><span class="lib-sheet">${s.kind === 'sheet' ? '—' : where}</span></td>
      <td class="lib-col"><span class="lib-state${on ? '' : ' off'}">${status}</span></td>
      <td class="lib-actions">${actions}</td>
    </tr>`;
  }).join('');
}

const linkTable = (rows, caption, statusHead) => `<table class="lib-table lib-links">
    <caption class="sr-only">${caption}</caption>
    <thead><tr><th scope="col">Shared item</th><th scope="col" class="lib-col">Kind</th><th scope="col" class="lib-col">In sheet</th><th scope="col" class="lib-col">${statusHead}</th><th scope="col" class="lib-actions"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows}</tbody></table>`;

// Active links first; ended ones (with why they ended) only when asked for.
function renderLinks() {
  if (!linksList.length) {
    linksBody.innerHTML = myPlan().share
      ? '<div class="lib-empty"><strong>No shared links</strong>Share a file or a sheet from its ••• menu. Its link shows up here.</div>'
      : '<div class="lib-empty"><strong>Share links come with Pro</strong>Send a file or a whole sheet to anyone with a link. <button class="link-btn" type="button" data-lib-upgrade>Upgrade to Pro</button></div>';
    return;
  }
  const all = linksList.map((s, i) => ({ s, i }));
  const active = all.filter(x => x.s.state === 'on').sort((a, b) => (b.s.createdAt || 0) - (a.s.createdAt || 0));
  const inactive = all.filter(x => x.s.state !== 'on').sort((a, b) => (b.s.endedAt || b.s.createdAt || 0) - (a.s.endedAt || a.s.createdAt || 0));
  const top = active.length
    ? linkTable(linkRows(active), 'Your active share links', 'Status')
    : `<div class="lib-empty"><strong>No active links</strong>${myPlan().share ? 'Share a file or a sheet from its ••• menu to make one.' : 'Share links come with Pro. <button class="link-btn" type="button" data-lib-upgrade>Upgrade to Pro</button>'}</div>`;
  const toggle = inactive.length
    ? `<button class="link-btn lib-inactive-toggle" type="button" data-links-inactive aria-expanded="${showInactiveLinks}" aria-controls="inactiveLinks">${showInactiveLinks ? 'Hide' : 'See'} inactive links (${inactive.length})</button>`
    : '';
  const ended = inactive.length && showInactiveLinks
    ? `<div id="inactiveLinks" class="lib-inactive"><p class="lib-note">These links no longer open anything. They’re cleared 30 days after they ended. To share again, make a new link from the item’s ••• menu.</p>${linkTable(linkRows(inactive), 'Inactive share links', 'Why it ended')}</div>`
    : '';
  linksBody.innerHTML = top + toggle + ended;
}

linksBody.addEventListener('click', async e => {
  if (e.target.closest('[data-lib-upgrade]')) return showUpgrade('');
  if (e.target.closest('[data-links-inactive]')) {
    showInactiveLinks = !showInactiveLinks;
    renderLinks();
    linksBody.querySelector('[data-links-inactive]')?.focus({ preventScroll: true });
    return;
  }
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.linkCopy) {
    const share = linksList[Number(btn.dataset.linkCopy)];
    if (!phoneShare() || !(await shareNatively(shareUrl(share), share.name))) copyLink(shareUrl(share));
  } else if (btn.dataset.linkOff) {
    const share = linksList[Number(btn.dataset.linkOff)];
    btn.disabled = true;
    try {
      const data = await sharePost({ action: 'revoke', token: share.token });
      noteShare(data.share);
      showToast('Link turned off');
      await loadLinks();
    } catch (err) {
      btn.disabled = false;
      showToast(err.message);
    }
  }
});

libraryModal.querySelector('[data-close-library]').addEventListener('click', () => closeLibrary());
libraryModal.querySelector('[data-library-back]').innerHTML = icon('back');
libraryModal.querySelector('[data-library-back]').addEventListener('click', () => closeLibrary({ back: true }));
libraryModal.addEventListener('click', e => { if (e.target === libraryModal) closeLibrary(); });

// ---- Plans and billing: Free and Pro, paid through Stripe ----
// The server enforces every limit; the page checks first to save a wasted upload.

const API_BILLING = '/.netlify/functions/billing';

function myPlan() {
  return account?.plan || { plan: 'pro', name: 'Pro', sheets: MAX_SHEETS, files: null, fileBytes: MAX_FILE_BYTES, share: true, billing: null, prices: { month: 0.99, year: 9.99 } };
}

const money = n => `$${Number(n).toFixed(2)}`;

function planLine() {
  const p = myPlan();
  if (p.plan === 'free') return 'Free plan';
  const b = p.billing;
  if (!b) return 'Pro plan';
  const when = b.renewsAt ? new Date(b.renewsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  if (b.cancelsAtEnd && when) return `Pro · ends ${when}`;
  return `Pro · ${b.interval === 'year' ? 'yearly' : 'monthly'}${when ? ` · renews ${when}` : ''}`;
}

// Free's limits show where they apply.
function applyPlan() {
  const sub = document.querySelector('.dz-sub');
  if (sub) sub.textContent = `Up to ${bytes(myPlan().fileBytes)} per file`;
}

// ---- Google Play Billing (inside the Android app) ----
// The Android app is this site in a Trusted Web Activity, opened at
// /?source=twa. There, Pro is bought through Google Play (Chrome's Digital
// Goods API + Payment Request), with Google's prices; the purchase token goes
// to the server, which checks it with Google before anything changes. On the
// web, Pro stays on Stripe. Kept per session: the app shares Chrome's storage
// with the browser, so this must never stick to ordinary Chrome tabs.
const PLAY_BILLING = 'https://play.google.com/billing';
const PLAY_PRODUCTS = { month: 'scrapsheet_pro_month', year: 'scrapsheet_pro_year' };
const API_PLAY = '/.netlify/functions/play';
const IN_ANDROID_APP = (() => {
  try {
    if (new URLSearchParams(location.search).get('source') === 'twa' || document.referrer.startsWith('android-app://')) sessionStorage.setItem('scrapsheet-android-app', '1');
    return sessionStorage.getItem('scrapsheet-android-app') === '1';
  } catch {
    return new URLSearchParams(location.search).get('source') === 'twa';
  }
})();
if (new URLSearchParams(location.search).get('source') === 'twa') history.replaceState(null, '', location.pathname + location.search.replace(/[?&]source=twa/, '').replace(/^&/, '?'));

let playServicePromise = null;
function playService() {
  if (!IN_ANDROID_APP || !('getDigitalGoodsService' in window)) return Promise.resolve(null);
  playServicePromise ||= window.getDigitalGoodsService(PLAY_BILLING).catch(() => null);
  return playServicePromise;
}

// Google's prices for this person's country, e.g. { month: { label: '$0.99', value: 0.99 }, … }.
async function playPrices(service) {
  const items = await service.getDetails(Object.values(PLAY_PRODUCTS));
  const out = {};
  for (const [interval, id] of Object.entries(PLAY_PRODUCTS)) {
    const item = items.find(i => i.itemId === id);
    if (!item?.price) continue;
    const value = Number(item.price.value);
    out[interval] = { value, label: new Intl.NumberFormat(undefined, { style: 'currency', currency: item.price.currency }).format(value) };
  }
  return out;
}

async function playVerify(token) {
  const r = await fetch(`${API_PLAY}?action=verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Couldn’t confirm the purchase. Try again in a minute.');
  return data;
}

function proArrived(plan) {
  account.plan = plan;
  applyPlan();
  if (!profileModal.hidden) renderProfile(profileView);
}

async function buyOnPlay(interval) {
  if (blockedOffline()) return;
  let response;
  try {
    const request = new PaymentRequest(
      [{ supportedMethods: PLAY_BILLING, data: { sku: PLAY_PRODUCTS[interval] } }],
      // Required by Payment Request, not used: Google Play shows the real price.
      { total: { label: 'Total', amount: { currency: 'USD', value: '0' } } }
    );
    response = await request.show();
  } catch (err) {
    showToast(err?.name === 'AbortError' ? 'No changes made' : 'Google Play couldn’t start the purchase. Try again.');
    return;
  }
  showToast('Finishing your upgrade…');
  try {
    const data = await playVerify(response.details.purchaseToken);
    await response.complete('success');
    if (data.pending) {
      showToast('Your payment is pending. Pro switches on as soon as Google Play confirms it.', { duration: 4000 });
      return;
    }
    proArrived(data.plan);
    showToast('Welcome to Pro');
  } catch (err) {
    await response.complete('fail').catch(() => {});
    showToast(err.message, { duration: 4000 });
  }
}

// Purchases this Google account already has (a new install, or one that wasn't
// confirmed in time): checked with the server, which links them if they're new.
async function checkPlayPurchases() {
  const service = await playService();
  if (!service) return;
  try {
    const owned = (await service.listPurchases()).filter(p => Object.values(PLAY_PRODUCTS).includes(p.itemId));
    if (!owned.length || myPlan().billing?.source === 'play') return;
    for (const p of owned) {
      const data = await playVerify(p.purchaseToken).catch(() => null);
      if (data?.plan?.plan === 'pro') {
        proArrived(data.plan);
        showToast('Your Google Play subscription is active: you’re on Pro');
        return;
      }
    }
  } catch {
    // Checked again next time the app opens.
  }
}

async function showPlayUpgrade(reason) {
  const service = await playService();
  const prices = service ? await playPrices(service).catch(() => ({})) : {};
  if (!prices.month && !prices.year) {
    openSheet({
      title: 'Upgrade to Pro',
      text: `${reason ? `${reason} ` : ''}Upgrading isn’t available in this version of the app right now. Update ScrapSheet from Google Play and try again.`,
      actions: [{ label: 'OK', kind: 'primary', full: true }]
    });
    return;
  }
  const save = prices.month && prices.year ? Math.round((1 - prices.year.value / (prices.month.value * 12)) * 100) : 0;
  openSheet({
    title: 'Upgrade to Pro',
    text: `${reason ? `${reason} ` : ''}Pro gives you 10 sheets, 5 GB of storage, files up to 100 MB each, and share links. Billed through Google Play; cancel anytime in the Play Store.`,
    // Yearly first: the better deal for people, and fewer charges to pay fees on.
    actions: [
      ...(prices.year ? [{ label: `${prices.year.label} / year${save > 0 ? ` · save ${save}%` : ''}`, kind: 'primary', full: true, run: () => buyOnPlay('year') }] : []),
      ...(prices.month ? [{ label: `${prices.month.label} / month`, kind: prices.year ? 'secondary' : 'primary', full: !prices.year, run: () => buyOnPlay('month') }] : []),
      { label: 'Not now', kind: 'secondary', full: !(prices.year && prices.month) }
    ]
  });
}

// The Pro offer: monthly or yearly, paid on Stripe's own page (or through
// Google Play inside the Android app).
function showUpgrade(reason) {
  if (IN_ANDROID_APP) {
    showPlayUpgrade(reason);
    return;
  }
  const { month, year } = myPlan().prices || { month: 0.99, year: 9.99 };
  const save = Math.round((1 - year / (month * 12)) * 100);
  openSheet({
    title: 'Upgrade to Pro',
    text: `${reason ? `${reason} ` : ''}Pro gives you 10 sheets, 5 GB of storage, files up to 100 MB each, and share links.`,
    // Yearly first: the better deal for people, and one card charge a year
    // instead of twelve (each charge carries a fixed fee).
    actions: [
      { label: `${money(year)} / year · save ${save}%`, kind: 'primary', full: true, run: () => startCheckout('year') },
      { label: `${money(month)} / month`, kind: 'secondary', run: () => startCheckout('month') },
      { label: 'Not now', kind: 'secondary' }
    ]
  });
}

async function billingPost(action, body = {}) {
  const r = await fetch(`${API_BILLING}?action=${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Payments aren’t available right now. Try again later.');
  return data;
}

async function startCheckout(interval) {
  showToast('Opening secure checkout…');
  try {
    const { url } = await billingPost('checkout', { interval });
    location.assign(url);
  } catch (err) {
    showToast(err.message);
  }
}

async function manageBilling() {
  const billing = myPlan().billing;
  // Bought in the Android app: Google Play manages it.
  if (billing?.source === 'play') {
    const params = billing.productId && billing.packageName ? `?sku=${encodeURIComponent(billing.productId)}&package=${encodeURIComponent(billing.packageName)}` : '';
    location.assign(`https://play.google.com/store/account/subscriptions${params}`);
    return;
  }
  // Paid on the web: managed there (the app doesn't send people to outside billing).
  if (IN_ANDROID_APP) {
    openSheet({
      title: 'Manage billing',
      text: `You pay for Pro on the web. To change or cancel it, open ${location.host} in your browser, sign in, and choose Manage billing in the account menu.`,
      actions: [{ label: 'OK', kind: 'primary', full: true }]
    });
    return;
  }
  showToast('Opening billing…');
  try {
    const { url } = await billingPost('portal');
    location.assign(url);
  } catch (err) {
    showToast(err.message);
  }
}

// Back from Stripe: Stripe tells the server separately, so wait a moment for Pro to show up.
async function afterCheckout() {
  const params = new URLSearchParams(location.search);
  const result = params.get('billing');
  if (!result) return;
  history.replaceState(null, '', '/');
  if (result === 'cancelled') {
    showToast('No changes made');
    return;
  }
  if (result !== 'success') return;
  showToast('Finishing your upgrade…');
  for (let i = 0; i < 15; i++) {
    const r = await rawFetch(API_AUTH, { cache: 'no-store' }).catch(() => null);
    const me = r?.ok ? await r.json() : null;
    if (me?.plan?.plan === 'pro') {
      account.plan = me.plan;
      applyPlan();
      showToast('Welcome to Pro');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  showToast('Payment received. Pro will switch on shortly; reload in a minute.');
}

// Chose Pro on the front page before having an account: offer it once signed in.
const PRO_INTENT = 'scrapsheet-wants-pro';
function offerProIfChosen() {
  let wanted = false;
  try {
    wanted = sessionStorage.getItem(PRO_INTENT) === '1';
    sessionStorage.removeItem(PRO_INTENT);
  } catch {
    // Not kept: nothing to offer.
  }
  if (wanted && myPlan().plan === 'free') showUpgrade('');
}

// ---- Account ----

const rawFetch = window.fetch.bind(window);

// Signed out elsewhere ("sign out everywhere", a password reset): back to sign-in.
// (Not for a request sent before this device's own password change, which
// already gave it a new sign-in.)
let signInRenewedAt = 0;
window.fetch = async (...args) => {
  const sentAt = Date.now();
  const r = await rawFetch(...args);
  if (r.status === 401 && appStarted && sentAt > signInRenewedAt) location.replace('/');
  return r;
};

// ---- Profile menu: a popover on desktop, a bottom sheet on phones ----
// Main: who you are and your plan, then Files & share links, Recently deleted,
// Account & security and Help & support (the last two open in place, with Back).

const profileModal = document.querySelector('#profileModal');
const profilePanel = document.querySelector('#profilePanel');
let profileView = 'main';

// Accounts have no separate name: the part of the email before "@", tidied.
function displayName(email = '') {
  const local = String(email).split('@')[0].replace(/\+.*$/, '');
  const words = local.split(/[._-]+/).map(w => w.replace(/\d+/g, '')).filter(Boolean);
  if (!words.length) return local || 'Your account';
  return words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

const chevron = () => `<span class="pf-chevron" aria-hidden="true">${icon('chevron')}</span>`;
const pfRow = (action, iconName, label, { sub = '', more = false, danger = false, external = false } = {}) =>
  `<button class="pf-row${danger ? ' danger' : ''}" type="button" data-pf="${action}">${icon(iconName)}<span class="pf-label"><span>${escapeHtml(label)}</span>${sub ? `<span class="pf-row-sub">${escapeHtml(sub)}</span>` : ''}</span>${more ? chevron() : external ? `<span class="pf-chevron" aria-hidden="true">${icon('open')}</span>` : ''}</button>`;

function profileHtml(view) {
  if (view === 'security') {
    const now = window.scratchTheme?.get() || 'light';
    const seg = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]
      .map(([value, label]) => `<button class="pf-seg-btn" type="button" role="radio" aria-checked="${value === now}" tabindex="${value === now ? 0 : -1}" data-theme-pick="${value}">${label}</button>`).join('');
    return `<div class="pf-subhead"><button class="pf-back" type="button" data-pf="back" aria-label="Back">${icon('back')}</button><h2 id="pfTitle">Account &amp; security</h2></div>
      <div class="pf-scroll">
        <h3 class="pf-group">Preferences</h3>
        <div class="pf-field"><span class="pf-field-label" id="pfAppearance">${icon('theme')}<span>Appearance</span></span>
          <div class="pf-seg" role="radiogroup" aria-labelledby="pfAppearance">${seg}</div></div>
        ${account?.keyring ? `<h3 class="pf-group">Security</h3>${pfRow('email', 'mail', 'Change email…', { sub: account?.email || '' })}${pfRow('password', 'lock', 'Change password…', { sub: 'Signs out your other devices' })}${pfRow('recovery', 'key', 'Generate new recovery key…', { sub: 'Replaces the key that resets your password' })}` : ''}
        <h3 class="pf-group">Your data</h3>
        ${pfRow('export', 'download', 'Download my data…', { sub: 'Every sheet, image and file in one .zip' })}
        <h3 class="pf-group">Sessions</h3>
        ${pfRow('signout', 'logout', 'Sign out')}
        ${pfRow('signout-all', 'devices', 'Sign out of all devices…')}
        <div class="pf-sep"></div>
        ${pfRow('delete', 'trash', 'Delete account…', { danger: true })}
      </div>`;
  }
  if (view === 'help') {
    return `<div class="pf-subhead"><button class="pf-back" type="button" data-pf="back" aria-label="Back">${icon('back')}</button><h2 id="pfTitle">Help &amp; support</h2></div>
      <div class="pf-scroll">
        ${pfRow('help-center', 'help', 'Help center', { sub: 'Answers to common questions', external: true })}
        ${pfRow('support', 'mail', 'Contact support', { sub: 'support@sector809labs.com', external: true })}
        ${pfRow('privacy', 'shield', 'Privacy policy', { external: true })}
        ${pfRow('terms', 'lines', 'Terms of service', { external: true })}
      </div>`;
  }
  const plan = myPlan();
  const pro = plan.plan !== 'free';
  const detail = pro && plan.billing ? planLine().replace(/^Pro · /, '') : pro ? '' : '1 sheet · 1 file · 10 MB';
  const planAction = !pro ? `<button class="pf-plan-btn" type="button" data-pf="upgrade">Upgrade to Pro</button>`
    : plan.billing ? `<button class="pf-plan-link" type="button" data-pf="billing">Manage billing</button>` : '';
  const email = account?.email || '';
  return `<div class="pf-head">
      <span class="pf-avatar" aria-hidden="true">${escapeHtml((displayName(email)[0] || '?').toUpperCase())}</span>
      <div class="pf-id"><h2 class="pf-name" id="pfTitle">${escapeHtml(displayName(email))}</h2><span class="pf-email">${escapeHtml(email).replace('@', '@<wbr>')}</span></div>
      <span class="pf-badge${pro ? ' pro' : ''}">${pro ? 'Pro' : 'Free'}</span>
    </div>
    ${detail || planAction ? `<div class="pf-plan"><span class="pf-plan-detail">${escapeHtml(detail)}</span>${planAction}</div>` : ''}
    <div class="pf-scroll pf-main">
      ${pfRow('library', 'folder', 'Files & share links', { more: true })}
      ${pfRow('trash', 'trash', 'Recently deleted')}
      ${pfRow('security', 'user', 'Account & security', { more: true })}
      ${pfRow('help', 'help', 'Help & support', { more: true })}
    </div>`;
}

const phoneLayout = () => matchMedia('(max-width: 699px)').matches;

function placeProfile() {
  if (profileModal.hidden) return;
  profileModal.classList.toggle('as-sheet', phoneLayout());
  if (phoneLayout()) {
    profilePanel.style.top = profilePanel.style.right = '';
    return;
  }
  const r = accountBtn.getBoundingClientRect();
  profilePanel.style.top = `${Math.round(r.bottom + 8)}px`;
  profilePanel.style.right = `${Math.max(8, Math.round(document.documentElement.clientWidth - r.right))}px`;
}

function renderProfile(view, { focusRow = null } = {}) {
  profileView = view;
  profilePanel.innerHTML = profileHtml(view);
  profilePanel.setAttribute('aria-labelledby', 'pfTitle');
  profilePanel.removeAttribute('aria-label');
  const target = (focusRow && profilePanel.querySelector(`[data-pf="${focusRow}"]`))
    || profilePanel.querySelector(view === 'main' ? '.pf-row, .pf-plan-btn' : '.pf-back');
  target?.focus({ preventScroll: true });
}

function openProfile(view = 'main', { focusRow = null } = {}) {
  closeMenu({ focusTrigger: false });
  if (profileModal.hidden) rememberFocus('profile');
  profileModal.hidden = false;
  accountBtn.setAttribute('aria-expanded', 'true');
  updateModalOpen();
  placeProfile();
  renderProfile(view, { focusRow });
}

function closeProfile({ restore = true } = {}) {
  if (profileModal.hidden) return;
  profileModal.hidden = true;
  accountBtn.setAttribute('aria-expanded', 'false');
  updateModalOpen();
  if (restore) restoreFocus('profile');
  else returnFocusTo.delete('profile');
}

// Leaves the menu, with focus back on the account button, then does the thing
// (so the next dialog returns focus there too).
function fromProfile(run) {
  closeProfile();
  run();
}

const PROFILE_ACTIONS = {
  library: () => { closeProfile(); openLibrary('files', { fromProfile: true }); },
  trash: () => fromProfile(openTrash),
  security: () => renderProfile('security'),
  help: () => renderProfile('help'),
  back: () => renderProfile('main', { focusRow: profileView }),
  upgrade: () => fromProfile(() => showUpgrade('')),
  billing: () => fromProfile(manageBilling),
  password: () => fromProfile(openChangePassword),
  email: () => fromProfile(openChangeEmail),
  recovery: () => fromProfile(confirmNewRecoveryKey),
  export: () => fromProfile(confirmDownloadData),
  signout: () => fromProfile(() => signOut('logout')),
  'signout-all': () => fromProfile(confirmSignOutEverywhere),
  delete: () => fromProfile(openDeleteAccount),
  support: () => fromProfile(() => { location.href = 'mailto:support@sector809labs.com'; }),
  privacy: () => fromProfile(() => window.open('/privacy', '_blank', 'noopener')),
  'help-center': () => fromProfile(() => window.open('/help', '_blank', 'noopener')),
  terms: () => fromProfile(() => window.open('/terms', '_blank', 'noopener'))
};

profilePanel.addEventListener('click', e => {
  const pick = e.target.closest('[data-theme-pick]');
  if (pick) {
    window.scratchTheme?.set(pick.dataset.themePick);
    updateBrandLabel();
    for (const btn of profilePanel.querySelectorAll('[data-theme-pick]')) {
      const on = btn === pick;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
    }
    pick.focus({ preventScroll: true });
    return;
  }
  const btn = e.target.closest('[data-pf]');
  if (btn) PROFILE_ACTIONS[btn.dataset.pf]?.();
});

profilePanel.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (profileView !== 'main') PROFILE_ACTIONS.back();
    else closeProfile();
    return;
  }
  // Appearance: arrow keys move between System, Light and Dark.
  const radio = e.target.closest('[data-theme-pick]');
  if (radio && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const all = [...profilePanel.querySelectorAll('[data-theme-pick]')];
    all[(all.indexOf(radio) + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length].click();
    return;
  }
  const focusables = [...profilePanel.querySelectorAll('button:not([tabindex="-1"])')];
  const i = focusables.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    focusables[(i + (e.key === 'ArrowDown' ? 1 : -1) + focusables.length) % focusables.length]?.focus();
  } else if (e.key === 'Tab') {
    // Focus stays in the menu while it's open.
    e.preventDefault();
    focusables[(i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length]?.focus();
  } else if (e.key === 'ArrowLeft' && profileView !== 'main' && !radio) {
    e.preventDefault();
    PROFILE_ACTIONS.back();
  }
});

profileModal.addEventListener('pointerdown', e => {
  if (e.target === profileModal) closeProfile();
});
window.addEventListener('resize', placeProfile);

accountBtn.setAttribute('aria-haspopup', 'dialog');
accountBtn.setAttribute('aria-expanded', 'false');
accountBtn.addEventListener('click', () => {
  if (!profileModal.hidden) closeProfile();
  else openProfile();
});

// Tapping the logo or name flips between light and dark (and keeps that choice).
const brandBtn = document.querySelector('#brandBtn');
// The sign-in page's sun/moon does the same.
const authThemeBtn = document.querySelector('#authThemeBtn');
function updateBrandLabel() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  brandBtn.setAttribute('aria-label', `ScrapSheet: switch to ${next} mode`);
  brandBtn.title = `Switch to ${next} mode`;
  authThemeBtn.setAttribute('aria-label', `Switch to ${next} mode`);
  authThemeBtn.title = `Switch to ${next} mode`;
}
function flipTheme() {
  window.scratchTheme?.set(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  updateBrandLabel();
}
brandBtn.addEventListener('click', flipTheme);
authThemeBtn.addEventListener('click', flipTheme);

// ---- "AES-256 (i)" on the sign-in page ----
// A small box beside the term: hovering shows it on desktop; a tap or click
// (or Enter/Space) opens it anywhere and keeps it open until a tap elsewhere,
// another tap on the term, or Escape.
const tipPop = document.querySelector('#aesTip');
let tipFor = null;
let tipPinned = false;
let tipHideTimer = null;
const canHover = () => matchMedia('(hover: hover)').matches;

function placeTip() {
  if (!tipFor) return;
  const r = tipFor.getBoundingClientRect();
  const w = tipPop.offsetWidth;
  const h = tipPop.offsetHeight;
  const margin = 16;
  const gap = 12;
  const left = Math.min(Math.max(margin, r.left + r.width / 2 - w / 2), innerWidth - margin - w);
  const above = r.top - gap - h >= margin;
  tipPop.dataset.side = above ? 'top' : 'bottom';
  tipPop.style.left = `${left}px`;
  tipPop.style.top = `${above ? r.top - gap - h : r.bottom + gap}px`;
  tipPop.style.setProperty('--arrow-x', `${Math.min(w - 18, Math.max(18, r.left + r.width / 2 - left))}px`);
}

function showTip(btn, pin) {
  clearTimeout(tipHideTimer);
  if (tipFor && tipFor !== btn) tipFor.setAttribute('aria-expanded', 'false');
  tipFor = btn;
  tipPinned = pin || tipPinned;
  btn.setAttribute('aria-expanded', 'true');
  tipPop.hidden = false;
  placeTip();
}

function hideTip() {
  clearTimeout(tipHideTimer);
  if (!tipFor) return;
  tipFor.setAttribute('aria-expanded', 'false');
  tipFor = null;
  tipPinned = false;
  tipPop.hidden = true;
}

// Hover: a short delay, so the pointer can move from the term onto the box.
const hideTipSoon = () => {
  clearTimeout(tipHideTimer);
  if (!tipPinned) tipHideTimer = setTimeout(hideTip, 180);
};

for (const btn of document.querySelectorAll('.tip-term')) {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (tipFor === btn && tipPinned) hideTip();
    else showTip(btn, true);
  });
  btn.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse' && canHover()) showTip(btn, false); });
  btn.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hideTipSoon(); });
}
tipPop.addEventListener('pointerenter', () => clearTimeout(tipHideTimer));
tipPop.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hideTipSoon(); });
document.addEventListener('click', e => { if (tipFor && !tipPop.contains(e.target)) hideTip(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !tipFor) return;
  const btn = tipFor;
  hideTip();
  btn.focus();
});
addEventListener('resize', placeTip);
addEventListener('scroll', placeTip, { passive: true, capture: true });
brandBtn.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    flipTheme();
  }
});
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => setTimeout(updateBrandLabel));
updateBrandLabel();

// ---- Delete account: everything in it, after the password (checked as the sign-in secret) ----

const deleteAccountModal = document.querySelector('#deleteAccountModal');
const deleteAccountForm = document.querySelector('#deleteAccountForm');
const deleteAccountError = document.querySelector('#deleteAccountError');
const deleteAccountPassword = document.querySelector('#deleteAccountPassword');

function openDeleteAccount() {
  rememberFocus('delete');
  deleteAccountModal.querySelector('#deleteAccountEmail').textContent = account?.email || 'this account';
  deleteAccountModal.querySelector('#deleteAccountUser').value = account?.email || '';
  deleteAccountModal.querySelector('#deleteAccountPro').hidden = !myPlan().billing || myPlan().plan !== 'pro';
  deleteAccountError.textContent = '';
  deleteAccountPassword.value = '';
  deleteAccountModal.hidden = false;
  updateModalOpen();
  deleteAccountPassword.focus();
}

function closeDeleteAccount() {
  if (deleteAccountModal.hidden) return;
  deleteAccountModal.hidden = true;
  updateModalOpen();
  restoreFocus('delete');
}

deleteAccountModal.querySelectorAll('[data-close-delete]').forEach(btn => btn.addEventListener('click', closeDeleteAccount));
deleteAccountModal.addEventListener('click', e => { if (e.target === deleteAccountModal) closeDeleteAccount(); });
deleteAccountModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeDeleteAccount(); });
deleteAccountForm.addEventListener('submit', async e => {
  e.preventDefault();
  const submit = deleteAccountForm.querySelector('[type="submit"]');
  const password = deleteAccountPassword.value;
  deleteAccountError.textContent = '';
  if (!password) {
    deleteAccountError.textContent = 'Enter your password.';
    return;
  }
  submit.disabled = true;
  submit.textContent = 'Deleting…';
  try {
    const { auth } = await vault.passwordKeys(account.email, password);
    // The server signs every device out before it answers: this page waits for
    // its own answer instead of reacting to that (and carries on if it fails).
    appStarted = false;
    const r = await rawFetch(`${API_AUTH}?action=delete-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Couldn’t delete the account. Try again.');
    await vault.forgetKeys();
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* nothing kept */ }
    deleteAccountForm.innerHTML = '<p class="delete-account-text"><strong>Your account was deleted.</strong> Everything in it is gone, and you’re signed out on every device.</p>';
    setTimeout(() => location.replace('/'), 2500);
  } catch (err) {
    appStarted = true;
    deleteAccountError.textContent = err.message;
    submit.disabled = false;
    submit.textContent = 'Delete account';
  }
});

// ---- Change password ----
// The device opens the master key with the current password and locks it again
// with the new one: nothing else is re-encrypted, the recovery key keeps
// working, and neither password leaves the device. Other devices are signed out.
const passwordModal = document.querySelector('#passwordModal');
const passwordChangeForm = document.querySelector('#passwordChangeForm');
const passwordChangeError = document.querySelector('#passwordChangeError');
const passwordFields = ['#currentPassword', '#changedPassword', '#changedPasswordAgain'].map(sel => document.querySelector(sel));

function openChangePassword() {
  if (blockedOffline()) return;
  rememberFocus('password');
  passwordModal.querySelector('#passwordChangeUser').value = account?.email || '';
  passwordChangeError.textContent = '';
  for (const field of passwordFields) field.value = '';
  passwordModal.hidden = false;
  updateModalOpen();
  passwordFields[0].focus();
}

function closeChangePassword() {
  if (passwordModal.hidden) return;
  passwordModal.hidden = true;
  updateModalOpen();
  restoreFocus('password');
}

passwordModal.querySelectorAll('[data-close-password]').forEach(btn => btn.addEventListener('click', closeChangePassword));
passwordModal.addEventListener('click', e => { if (e.target === passwordModal) closeChangePassword(); });
passwordModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeChangePassword(); });
passwordChangeForm.addEventListener('submit', async e => {
  e.preventDefault();
  const submit = passwordChangeForm.querySelector('[type="submit"]');
  const [current, next, again] = passwordFields.map(field => field.value);
  passwordChangeError.textContent = '';
  const fail = message => { passwordChangeError.textContent = message; };
  if (!current) return fail('Enter your current password.');
  if (next.length < 8) return fail('Use at least 8 characters for the new password.');
  if (next !== again) return fail('The new passwords don’t match.');
  if (next === current) return fail('Choose a password different from the current one.');
  if (blockedOffline()) return;
  submit.disabled = true;
  submit.textContent = 'Changing…';
  try {
    const old = await vault.passwordKeys(account.email, current);
    let master;
    try {
      master = await vault.openWithPassword(account.keyring, old.kek);
    } catch {
      throw new Error('Your current password isn’t right.');
    }
    const fresh = await vault.passwordKeys(account.email, next);
    const byPassword = await vault.wrap(master, fresh.kek);
    // The server signs every other device out before it answers: this page
    // waits for its own answer (with this device's new sign-in) instead.
    appStarted = false;
    const r = await rawFetch(`${API_AUTH}?action=change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth: old.auth, newAuth: fresh.auth, byPassword })
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) signInRenewedAt = Date.now();
    appStarted = true;
    if (!r.ok) throw new Error(data.error || 'Couldn’t change the password. Try again.');
    if (data.keyring) account.keyring = data.keyring;
    closeChangePassword();
    showToast('Password changed. Your other devices were signed out.');
  } catch (err) {
    appStarted = true;
    fail(err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = 'Change password';
  }
});

// ---- Change email ----
// The email salts the password key, so the device makes the sign-in secret and
// the master key's lock again from the new email and the same password (the
// recovery key doesn't depend on the email). A code to the new address proves
// it's yours. Other devices are signed out; the old address gets a notice.
const emailModal = document.querySelector('#emailModal');
const emailChangeForm = document.querySelector('#emailChangeForm');
const emailChangeError = document.querySelector('#emailChangeError');
const emailChangeSubmit = document.querySelector('#emailChangeSubmit');
let emailChange = null; // { newEmail, old, master, password } between the two steps

function setEmailStep(step) {
  emailModal.querySelectorAll('[data-email-step]').forEach(el => { el.hidden = el.dataset.emailStep !== String(step); });
  emailChangeSubmit.textContent = step === 1 ? 'Send code' : 'Change email';
}

function openChangeEmail() {
  if (blockedOffline()) return;
  rememberFocus('email');
  emailChange = null;
  emailModal.querySelector('#emailChangeUser').value = account?.email || '';
  for (const id of ['#emailChangeNew', '#emailChangePassword', '#emailChangeCode']) emailModal.querySelector(id).value = '';
  emailChangeError.textContent = '';
  setEmailStep(1);
  emailModal.hidden = false;
  updateModalOpen();
  emailModal.querySelector('#emailChangeNew').focus();
}

function closeChangeEmail() {
  if (emailModal.hidden) return;
  emailModal.hidden = true;
  emailChange = null;
  updateModalOpen();
  restoreFocus('email');
}

emailModal.querySelectorAll('[data-close-email]').forEach(btn => btn.addEventListener('click', closeChangeEmail));
emailModal.addEventListener('click', e => { if (e.target === emailModal) closeChangeEmail(); });
emailModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeChangeEmail(); });
emailChangeForm.addEventListener('submit', async e => {
  e.preventDefault();
  emailChangeError.textContent = '';
  if (blockedOffline()) return;
  const label = emailChangeSubmit.textContent;
  emailChangeSubmit.disabled = true;
  try {
    if (!emailChange) {
      const newEmail = emailModal.querySelector('#emailChangeNew').value.trim().toLowerCase();
      const password = emailModal.querySelector('#emailChangePassword').value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) throw new Error('Enter a valid email address.');
      if (newEmail === account.email) throw new Error('That’s already your email.');
      if (!password) throw new Error('Enter your password.');
      emailChangeSubmit.textContent = 'Checking…';
      const old = await vault.passwordKeys(account.email, password);
      let master;
      try {
        master = await vault.openWithPassword(account.keyring, old.kek);
      } catch {
        throw new Error('Your password isn’t right.');
      }
      emailChangeSubmit.textContent = 'Sending…';
      await postJson(`${API_AUTH}?action=email-code`, { auth: old.auth, newEmail });
      emailChange = { newEmail, old, master, password };
      emailModal.querySelector('#emailChangeTo').textContent = newEmail;
      setEmailStep(2);
      emailModal.querySelector('#emailChangeCode').focus();
      return;
    }
    const code = emailModal.querySelector('#emailChangeCode').value.trim();
    if (!code) throw new Error('Enter the code from the email.');
    emailChangeSubmit.textContent = 'Changing…';
    const { newEmail, old, master, password } = emailChange;
    const fresh = await vault.passwordKeys(newEmail, password);
    const byPassword = await vault.wrap(master, fresh.kek);
    // As with a new password: this page waits for its own answer (and its new sign-in).
    appStarted = false;
    const r = await rawFetch(`${API_AUTH}?action=change-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth: old.auth, newEmail, code, newAuth: fresh.auth, byPassword })
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) signInRenewedAt = Date.now();
    appStarted = true;
    if (!r.ok) throw new Error(data.error || 'Couldn’t change the email. Try again.');
    account.email = data.email;
    if (data.keyring) account.keyring = data.keyring;
    await vault.rememberMaster(data.email, master);
    avatarEl.textContent = data.email.charAt(0).toUpperCase();
    accountBtn.title = data.email;
    accountBtn.setAttribute('aria-label', `Account: ${data.email}`);
    saveSnapshot();
    closeChangeEmail();
    showToast(`Your email is now ${data.email}`);
  } catch (err) {
    appStarted = true;
    emailChangeError.textContent = err.message;
  } finally {
    emailChangeSubmit.disabled = false;
    if (emailChangeSubmit.textContent.endsWith('…')) emailChangeSubmit.textContent = label;
  }
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

async function signOut(action) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveState(activeSheet);
  }
  await rawFetch(`${API_AUTH}?action=${action}`, { method:'POST' }).catch(() => {});
  await vault.forgetKeys();
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
let resetRecovery = null;   // an encrypted account's recovery-locked key, from the code step
let recoveredMaster = null; // its master key, once the recovery key opened it
let startOver = false;

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

// Like authPost, but hands back 409s (an account from before encryption, a keyring already made).
async function authRequest(action, body) {
  const r = await rawFetch(`${API_AUTH}?action=${action}`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify(body)
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

// The password never leaves this device: it becomes a sign-in secret (sent)
// and a key that opens the account's master key (kept here).
async function keysFromPassword(email, password, button) {
  const label = button?.textContent;
  if (button) button.textContent = 'Unlocking…';
  try {
    return await vault.passwordKeys(email, password);
  } finally {
    if (button) button.textContent = label;
  }
}

// Opens the account's keyring (or makes the first one, for an account from
// before encryption) and keeps the master key on this device. Returns a new
// recovery key to show, if one was made.
async function settleKeys(me, kek) {
  if (me.keyring) {
    await vault.rememberMaster(me.email, await vault.openWithPassword(me.keyring, kek));
    return null;
  }
  const made = await vault.newKeyring(kek);
  const r = await authRequest('keyring', { keyring: made.keyring });
  if (r.status === 409 && r.data.keyring) {
    // Another device set it up first.
    await vault.rememberMaster(me.email, await vault.openWithPassword(r.data.keyring, kek));
    return null;
  }
  if (!r.ok) throw new Error(r.data.error || 'Something went wrong. Try again.');
  await vault.rememberMaster(me.email, made.master);
  return made.recoveryKey;
}

// Into the app, by way of the new recovery key if there is one.
function enterApp(recoveryKey) {
  if (recoveryKey) showRecoveryKey(recoveryKey, () => location.replace('/'));
  else location.replace('/');
}

authForm('#signinForm', async form => {
  authEmail = document.querySelector('#signinEmail').value.trim();
  const password = document.querySelector('#signinPassword').value;
  if (!authEmail || !password) throw new Error('Enter your email and password.');
  const { auth, kek } = await keysFromPassword(authEmail, password, form.querySelector('.auth-submit'));
  let r = await authRequest('login', { email: authEmail, auth });
  // From before encryption: the password goes once more, so the server can check it and switch over.
  if (r.status === 409 && r.data.legacy) r = await authRequest('login', { email: authEmail, auth, password });
  if (!r.ok) throw new Error(r.data.error || 'Something went wrong. Try again.');
  enterApp(await settleKeys(r.data, kek));
});

// Signed in, but this device doesn't hold the keys (or the account isn't encrypted yet).
let unlockPurpose = 'open';

function showUnlock(purpose = 'open') {
  unlockPurpose = purpose;
  const text = document.querySelector('#unlockText');
  const title = document.querySelector('#unlockForm h2');
  const alt = document.querySelector('#unlockForm .auth-alt');
  if (purpose === 'recovery') {
    title.textContent = 'New recovery key';
    text.textContent = 'Enter your password to make a new recovery key. Your old one will stop working.';
    alt.innerHTML = '<button class="link-btn" type="button" data-cancel-unlock>Cancel</button>';
  } else {
    title.textContent = account.keyring ? 'Unlock your sheets' : 'Turn on encryption';
    text.textContent = account.keyring
      ? 'Your sheets and files are end-to-end encrypted. Enter your password to open them on this device.'
      : 'ScrapSheet now locks your sheets and files with your password, so only you can read them. Enter it once to turn this on.';
    alt.innerHTML = '<button class="link-btn" type="button" data-go="email" data-mode="reset">Forgot password?</button> · <button class="link-btn" type="button" data-sign-out>Sign out</button>';
  }
  authEmail = account.email;
  document.querySelector('#unlockEmail').value = account.email;
  document.querySelector('#unlockPassword').value = '';
  showAuth('unlock');
}

authForm('#unlockForm', async form => {
  const password = document.querySelector('#unlockPassword').value;
  if (!password) throw new Error('Enter your password.');
  const { auth, kek } = await keysFromPassword(account.email, password, form.querySelector('.auth-submit'));
  if (unlockPurpose === 'recovery') {
    const master = await vault.openWithPassword(account.keyring, kek);
    const { recoveryKey, keyring } = await vault.rewrapForRecovery(account.keyring, master);
    const data = await authPost('recovery', { auth, byRecovery: keyring.byRecovery, recoverySalt: keyring.recoverySalt });
    account.keyring = data.keyring;
    showRecoveryKey(recoveryKey, hideAuth);
    return;
  }
  // Not encrypted yet: the server checks the password (and switches to the sign-in secret) first.
  if (!account.keyring) await authPost('upgrade', { password, auth });
  enterApp(await settleKeys(account, kek));
});

function hideAuth() {
  authScreen.hidden = true;
  document.body.classList.remove('signed-out');
}

function confirmNewRecoveryKey() {
  openSheet({
    title: 'Make a new recovery key?',
    text: 'You’ll get a new key to save. The one you have now will stop working.',
    actions: [
      { label: 'Cancel', kind: 'secondary' },
      { label: 'Continue', kind: 'primary', run: () => showUnlock('recovery') }
    ]
  });
}

// ---- The recovery key: shown once, to save ----

let afterRecoveryKey = null;

function showRecoveryKey(key, next) {
  afterRecoveryKey = next;
  document.querySelector('#recoveryKeyText').textContent = key;
  document.querySelector('#recoverySaved').checked = false;
  showAuth('recovery-key');
}

authForm('#recoveryKeyForm', async () => {
  if (!document.querySelector('#recoverySaved').checked) throw new Error('Save your recovery key first, then tick the box.');
  const next = afterRecoveryKey;
  afterRecoveryKey = null;
  document.querySelector('#recoveryKeyText').textContent = '';
  next?.();
});

authScreen.addEventListener('click', async e => {
  const key = document.querySelector('#recoveryKeyText').textContent;
  if (e.target.closest('[data-copy-recovery]')) {
    try {
      await navigator.clipboard.writeText(key);
      showToast('Recovery key copied');
    } catch {
      getSelection().selectAllChildren(document.querySelector('#recoveryKeyText'));
      showToast('Selected: copy it from here');
    }
  } else if (e.target.closest('[data-save-recovery]')) {
    const text = `ScrapSheet recovery key\n\nAccount: ${authEmail || account?.email || ''}\nRecovery key: ${key}\n\nThis key opens your encrypted sheets and files if you forget your password.\nKeep it private and somewhere safe.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ScrapSheet recovery key.txt';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } else if (e.target.closest('[data-sign-out]')) {
    signOut('logout');
  } else if (e.target.closest('[data-cancel-unlock]')) {
    hideAuth();
  } else if (e.target.closest('[data-start-over]')) {
    openSheet({
      title: 'Start over with an empty account?',
      text: 'Without your recovery key, nothing in this account can be opened, by you or by us. Starting over erases its sheets, files and share links and gives you an empty account with the same email. This can’t be undone.',
      actions: [
        { label: 'Cancel', kind: 'secondary' },
        { label: 'Erase and start over', kind: 'danger-solid', run: () => { startOver = true; showAuth('password'); } }
      ]
    });
  }
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
  resetRecovery = data.recovery || null;
  recoveredMaster = null;
  startOver = false;
  document.querySelector('#passwordTitle').textContent = data.existing ? 'Choose a new password' : 'Choose a password';
  if (resetRecovery) {
    document.querySelector('#recoverInput').value = '';
    showAuth('recover');
  } else {
    showAuth('password');
  }
});

authForm('#recoverForm', async () => {
  recoveredMaster = await vault.openWithRecovery(resetRecovery, document.querySelector('#recoverInput').value);
  startOver = false;
  showAuth('password');
});

authForm('#passwordForm', async form => {
  const password = document.querySelector('#newPassword').value;
  if (password.length < 8) throw new Error('Use at least 8 characters.');
  const { auth, kek } = await keysFromPassword(authEmail, password, form.querySelector('.auth-submit'));
  const body = { token: passwordToken, auth };
  let master;
  let recoveryKey = null;
  if (resetRecovery && !startOver) {
    // The same master key, now locked with the new password too.
    if (!recoveredMaster) {
      showAuth('recover');
      return;
    }
    master = recoveredMaster;
    body.byPassword = await vault.wrap(master, kek);
  } else {
    ({ master, recoveryKey, keyring: body.keyring } = await vault.newKeyring(kek));
    if (startOver) body.startOver = true;
  }
  const data = await authPost('set-password', body);
  await vault.rememberMaster(data.email, master);
  enterApp(recoveryKey);
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

// Plan cards act as buttons from the keyboard too.
authScreen.addEventListener('keydown', e => {
  const card = e.target.closest('.plan-card[data-go]');
  if (card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    card.click();
  }
});

authScreen.addEventListener('click', async e => {
  // Picked Pro before having an account: offer it right after signing up.
  if (e.target.closest('.plan-pro')) {
    try { sessionStorage.setItem(PRO_INTENT, '1'); } catch { /* not kept */ }
  }
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

// ---- Turning encryption on: everything from before is locked once, on this device ----

const quietTransfer = () => ({ signal: new AbortController().signal, update() {}, status() {}, done() {}, fail() {} });

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function getBytes(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

// Every slot that holds anything: the sheets, and those in Recently Deleted, each with its key.
async function slotsToLock() {
  await ensureSheetKeys();
  const slots = sheets.map(s => s.id);
  const { sheets: trashed = [] } = await getJson(`${API_STATE}?meta=trash`);
  for (const t of trashed) {
    const id = Number(t.id);
    if (t.key) {
      await sheetKeyFrom(id, t.key);
    } else {
      const key = await vault.newKey();
      const wrapped = await vault.wrap(key, masterKey);
      await postSheets({ action: 'set-key', sheet: id, key: wrapped, name: await vault.encryptText(key, t.name) });
      sheetKeys.set(id, { wrapped, key });
    }
    slots.push(id);
  }
  return slots;
}

// An image in the text, copied as a locked image. Returns the new id.
async function lockImage(sheet, id, key) {
  const info = await getJson(imageUrl(sheet, `id=${encodeURIComponent(id)}&info=1`));
  if (info.enc) return id;
  const parts = [];
  for (let i = 0; i < info.chunks; i++) parts.push(await getBytes(imageUrl(sheet, `id=${encodeURIComponent(id)}&chunk=${i}`)));
  const original = new Blob(parts, { type: info.type });
  const start = await postJson(imageUrl(sheet, 'action=start'), { type: await vault.encryptText(key, info.type), size: original.size, enc: 1 });
  const newId = encodeURIComponent(start.id);
  const signal = new AbortController().signal;
  const seal = async part => new Blob([await vault.encryptBytes(key, new Uint8Array(await part.arrayBuffer()))]);
  if (info.preview) {
    const preview = new Blob([await getBytes(imageUrl(sheet, `id=${encodeURIComponent(id)}`))]);
    const sealedPreview = await seal(preview);
    const previewType = await vault.encryptText(key, info.preview);
    await withRetry(() => putChunk(imageUrl(sheet, `id=${newId}&preview=1&type=${encodeURIComponent(previewType)}`), sealedPreview, signal, () => {}), signal);
  }
  for (let i = 0; i < start.chunks; i++) {
    const part = await seal(original.slice(i * start.chunkSize, Math.min(original.size, (i + 1) * start.chunkSize)));
    await withRetry(() => putChunk(imageUrl(sheet, `id=${newId}&chunk=${i}`), part, signal, () => {}), signal);
  }
  await postJson(imageUrl(sheet, `id=${newId}&action=finish`));
  return start.id;
}

// A sheet's text and its images, locked. Its old images go once the locked text is saved.
async function lockSheetText(sheet) {
  const data = await getJson(stateUrl(sheet));
  if (vault.isSealed(data.html)) return;
  let html = typeof data.html === 'string' ? data.html : textToHtml(data.text || '');
  if (!html && !data.updatedAt) return;
  const key = await keyForSheet(sheet);
  const oldIds = [...new Set([...html.matchAll(/images\?sheet=(?:[1-9]|10)(?:&amp;|&)id=([A-Za-z0-9-]{1,64})/g)].map(m => m[1]))];
  const newIds = [];
  for (const id of oldIds) {
    let next;
    try {
      next = await lockImage(sheet, id, key);
    } catch (err) {
      // Already gone: nothing to keep.
      if (String(err.message).includes('404')) continue;
      throw err;
    }
    html = html.split(id).join(next);
    newIds.push(next);
  }
  const r = await fetch(stateUrl(sheet), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '', html: await vault.encryptText(key, html), filled: htmlHasContent(html), images: newIds })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  for (const id of oldIds) {
    if (!newIds.includes(id)) await fetch(imageUrl(sheet, `id=${encodeURIComponent(id)}`), { method: 'DELETE' }).catch(() => {});
  }
}

// A sheet's files from before encryption (Recently Deleted too), each replaced by a locked copy.
async function lockSheetFiles(sheet) {
  const { files } = await getJson(filesUrl(sheet, 'all=1'));
  for (const f of files.filter(x => !x.enc)) {
    const parts = [];
    for (let i = 0; i < f.chunks; i++) parts.push(await getBytes(filesUrl(sheet, `id=${encodeURIComponent(f.id)}&chunk=${i}`)));
    const file = new File(parts, f.name, { type: f.type || '' });
    if (!(await uploadFile(file, sheet, quietTransfer(), { migrateFrom: f.id }))) throw new Error('A file couldn’t be locked');
  }
}

let lockSlots = [];

// Before the editor opens: every sheet's text and images.
async function lockAllText() {
  showToast('Encrypting your sheets…');
  lockSlots = await slotsToLock();
  for (const sheet of lockSlots) await lockSheetText(sheet);
}

// Then, in the background: files, old share links, and done.
async function lockTheRest() {
  try {
    for (const sheet of lockSlots) {
      await lockSheetFiles(sheet);
      if (sheet === activeSheet) loadFiles(true, sheet);
    }
    // Links from before point at what has now been replaced; they're turned off.
    const { shares = [] } = await getJson(`${API_SHARE}?mine=1`);
    for (const share of shares.filter(x => x.state === 'on')) await sharePost({ action: 'revoke', token: share.token, reason: 'encryption' }).catch(() => {});
    await authPost('migrated', {});
    account.locked = 'on';
    showToast('Your sheets and files are now end-to-end encrypted');
    loadUsage();
  } catch (err) {
    console.error('Encrypting files failed', err);
    showToast('Couldn’t finish encrypting your files. It will carry on next time.');
  }
}

// Files and images locked before their types were: their types get locked too, once.
async function sealOldTypes() {
  try {
    for (const sheet of await slotsToLock()) {
      const key = await keyForSheet(sheet);
      const { files } = await getJson(filesUrl(sheet, 'all=1'));
      for (const f of files.filter(x => x.enc && !vault.isSealed(x.type))) {
        const fileKey = await vault.unwrap(f.key, key);
        await postJson(filesUrl(sheet, `id=${encodeURIComponent(f.id)}&action=seal-type`), { type: await vault.encryptText(fileKey, f.type || 'application/octet-stream') });
      }
      const html = await sheetHtml(sheet, await getJson(stateUrl(sheet)));
      const ids = new Set([...html.matchAll(/images\?sheet=(?:[1-9]|10)(?:&amp;|&)id=([A-Za-z0-9-]{1,64})/g)].map(m => m[1]));
      for (const id of ids) {
        const info = await getJson(imageUrl(sheet, `id=${encodeURIComponent(id)}&info=1`)).catch(() => null);
        if (!info?.enc || vault.isSealed(info.type)) continue;
        await postJson(imageUrl(sheet, `id=${encodeURIComponent(id)}&action=seal-type`), {
          type: await vault.encryptText(key, info.type),
          ...(info.preview ? { preview: await vault.encryptText(key, info.preview) } : {})
        });
      }
    }
    await authPost('types-sealed', {});
    account.typesSealed = true;
  } catch (err) {
    console.error('Locking file types failed', err);
  }
}

async function startApp() {
  document.body.classList.remove('signed-out');
  authScreen.hidden = true;
  applyPlan();
  avatarEl.textContent = (account.email || '?').charAt(0).toUpperCase();
  accountBtn.title = account.email;
  accountBtn.setAttribute('aria-label', `Account: ${account.email}`);
  await fetchSheets();
  let locking = false;
  if (masterKey) {
    try {
      if (account.locked === 'migrating') {
        await lockAllText();
        locking = true;
      } else {
        await ensureSheetKeys();
      }
    } catch (err) {
      console.error('Encrypting sheets failed', err);
      showToast('Couldn’t encrypt your sheets. Reload to try again.');
    }
  }
  renderTabs();
  const startSheet = (await fetchCurrentSheet()) || rememberedSheet() || sheets[0].id;
  prefetchSheets();
  await switchSheet(startSheet, { remember:false, force:true });
  appStarted = true;
  scheduleSnapshot();
  afterCheckout();
  offerProIfChosen();
  receiveShared();
  checkPlayPurchases();
  if (locking) lockTheRest().then(() => { if (account.locked === 'on') sealOldTypes(); });
  else if (masterKey && account.locked === 'on' && !account.typesSealed) sealOldTypes();
  connectSync();
  // Every 2 seconds while the relay is down or this device is offline (view
  // only); every 5 minutes as a safety net while live sync is connected.
  setInterval(() => {
    if (!socketHealthy || viewOnly || Date.now() - lastCheckAt > SAFETY_CHECK_MS) checkForChanges();
  }, POLL_MS);
}

// ---- Share to ScrapSheet ----
// Installed on Android, ScrapSheet is in the system Share menu. The service
// worker (sw.js) keeps what was shared on this device and opens /?shared=1;
// here it's offered for the open sheet, then the files are locked and uploaded
// like any other, and text is added at the end of the sheet. Nothing shared
// reaches the server unlocked.

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function shareInbox(mode, run) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('scratchpad-share', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('inbox', { autoIncrement: true });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('inbox', mode);
      const result = run(tx.objectStore('inbox'));
      tx.oncomplete = () => { db.close(); resolve(result.value); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

// Everything waiting, oldest first, as one: { files, text }.
function peekShared() {
  return shareInbox('readonly', store => {
    const out = { value: null };
    const req = store.getAll();
    req.onsuccess = () => {
      const items = req.result || [];
      if (items.length) out.value = { files: items.flatMap(i => i.files || []), text: items.map(i => i.text).filter(Boolean).join('\n\n') };
    };
    return out;
  }).catch(() => null);
}

const clearShared = () => shareInbox('readwrite', store => { store.clear(); return { value: true }; }).catch(() => {});

function addSharedText(text) {
  const nodes = cleanHtml(textToHtml(text));
  if (!editorIsEmpty()) pad.append(document.createElement('div'));
  pad.append(...nodes.childNodes);
  onEditorChanged();
  showPadImages(pad);
}

async function receiveShared() {
  if (new URLSearchParams(location.search).has('shared')) history.replaceState(null, '', location.pathname);
  if (!('indexedDB' in window)) return;
  const shared = await peekShared();
  if (!shared || (!shared.files.length && !shared.text)) return;
  // Kept on the device until there's a connection to add it.
  if (viewOnly) {
    showToast('Reconnect to add what you shared.', { duration: 3000 });
    return;
  }
  const { files, text } = shared;
  const count = files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '';
  const what = [count, text ? 'text' : ''].filter(Boolean).join(' and ');
  const preview = text ? `“${text.length > 140 ? `${text.slice(0, 140).trim()}…` : text}”` : '';
  openSheet({
    title: 'Add what you shared',
    text: [`Adds ${what} to ${currentSheetName()}.`, preview].filter(Boolean).join('\n'),
    files,
    actions: [
      { label: 'Discard', kind: 'secondary', run: () => clearShared() },
      {
        label: `Add to ${currentSheetName()}`,
        kind: 'primary',
        run: async () => {
          if (blockedOffline()) return;
          await clearShared();
          if (text) addSharedText(text);
          if (files.length) uploadFiles(files, activeSheet);
          else showToast(`Added to ${currentSheetName()}`);
        }
      }
    ]
  });
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

// One small request every 2 seconds while ScrapSheet is on screen; the
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

// ---- Instant open: an encrypted copy of what the app last showed ----
// Tabs, the open sheet (and other kept sheets), file lists and plan, sealed
// with this device's master key and kept beside it in IndexedDB. On the next
// open it's drawn before any request; the usual sync then brings in anything
// newer. Signing out (or a 401) clears it with the key.


function scheduleSnapshot() {
  if (!appStarted || !masterKey) return;
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(saveSnapshot, 1500);
}

async function saveSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = null;
  if (!appStarted || !masterKey || !account?.email || !sheets.length) return;
  try {
    // The open sheet first, then the rest while they fit.
    let room = SNAPSHOT_MAX_CHARS;
    const html = {};
    for (const id of [activeSheet, ...sheets.map(s => s.id).filter(id => id !== activeSheet)]) {
      const kept = sheetCache.get(id);
      if (!kept || kept.html.length > room) continue;
      room -= kept.html.length;
      html[id] = { html: kept.html, updatedAt: kept.updatedAt };
    }
    const files = {};
    for (const [id, list] of filesCache) if (hasSheet(id)) files[id] = { list: [...list], signature: list.signature || '' };
    const data = {
      v: 1,
      at: Date.now(),
      email: account.email,
      plan: account.plan || null,
      sheets,
      sheetsSignature,
      activeSheet,
      html,
      files,
      status: [...sheetStatus]
    };
    await vault.keepSnapshot({ email: account.email, data: await vault.encryptText(masterKey, JSON.stringify(data)) });
  } catch (err) {
    console.error('Keeping a copy for next time failed', err);
  }
}

// Kept as the page goes to the background, so the next open matches.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && appStarted) saveSnapshot();
});

// Draws the kept copy, read-only until the server has been checked. Returns
// the account's email, or null when there's nothing to draw.
async function paintFromSnapshot() {
  try {
    const kept = await vault.recallSnapshot();
    if (!kept?.email) return null;
    const key = await vault.recallMaster(kept.email);
    if (!key) return null;
    const data = JSON.parse(await vault.decryptText(key, kept.data));
    if (data?.v !== 1 || data.email !== kept.email || !Array.isArray(data.sheets) || !data.sheets.length) return null;

    masterKey = key;
    account = { email: data.email, plan: data.plan || undefined, keyring: true, locked: 'on' };
    sheets = data.sheets;
    sheetsSignature = data.sheetsSignature || '';
    for (const [id, c] of Object.entries(data.html || {})) sheetCache.set(Number(id), { html: c.html, updatedAt: c.updatedAt, content: htmlHasContent(c.html) });
    for (const [id, f] of Object.entries(data.files || {})) {
      const list = f.list || [];
      list.signature = f.signature;
      filesCache.set(Number(id), list);
      for (const file of list) knownFiles.set(file.id, file);
    }
    for (const [id, st] of data.status || []) sheetStatus.set(Number(id), st);

    document.body.classList.remove('signed-out');
    authScreen.hidden = true;
    avatarEl.textContent = data.email.charAt(0).toUpperCase();
    applyPlan();
    const remembered = rememberedSheet();
    activeSheet = hasSheet(remembered) ? remembered : hasSheet(data.activeSheet) ? data.activeSheet : sheets[0].id;
    const cached = sheetCache.get(activeSheet);
    localUpdatedAt = cached ? cached.updatedAt : 0;
    pad.contentEditable = 'false';
    if (cached) renderEditor(cached.html);
    pad.classList.toggle('is-loading', !cached);
    updateEmptyState();
    showCachedFiles(activeSheet);
    updateFilesSubtitle();
    renderTabs();
    revealActiveTab(false);
    setSaveState(cached ? 'saved' : 'loading');
    painted = { email: data.email };
    return data.email;
  } catch (err) {
    console.error('Couldn’t open the kept copy', err);
    return null;
  }
}

// The kept copy belonged to someone else, or can't be used: back to a blank start.
function clearPainted() {
  painted = null;
  masterKey = null;
  account = null;
  sheetCache.clear();
  filesCache.clear();
  sheetStatus.clear();
  knownFiles.clear();
  sheets = [{ id: 1, name: 'Sheet 1' }];
  sheetsSignature = '';
  pad.replaceChildren();
  showCachedFiles(activeSheet);
  renderTabs();
}

// Who is signed in, retrying while the network is down (a failed request
// isn't a sign-out: only the server saying so is).
async function whoAmI() {
  for (let delay = 1500; ; delay = Math.min(delay * 2, 15000)) {
    const r = await rawFetch(API_AUTH, { cache: 'no-store' }).catch(() => null);
    if (r) return r;
    setConnection('offline');
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

// ---- Updates: a tab left open picks up a new version of ScrapSheet ----
// The page notes the version it loaded (the ETags of app.js and the page) and
// checks again on return to the page (at most every 10 minutes) and hourly.
// When a new one is out it reloads at a quiet moment: in the background, on
// return to the page, or after 2 minutes without use. Never with unsaved
// edits, a transfer running, an image uploading, a delete waiting for Undo or
// a dialog open; and at most once every 10 minutes per tab.
const UPDATE_CHECK_MS = 60 * 60_000;
const UPDATE_RECHECK_MS = 10 * 60_000;
const UPDATE_IDLE_MS = 2 * 60_000;
const UPDATE_RELOAD_GAP_MS = 10 * 60_000;
let loadedVersion = null;
let lastVersionCheck = 0;
let updateReady = false;
let lastUseAt = Date.now();
let returnedAt = 0; // when the page last came back to the front

async function siteVersion() {
  const tags = await Promise.all(['/app.js', '/'].map(url =>
    fetch(url, { method: 'HEAD', cache: 'no-store' }).then(r => (r.ok ? r.headers.get('etag') : null))
  ));
  return tags.every(Boolean) ? tags.join(' ') : null;
}

async function checkForUpdate() {
  if (updateReady || !navigator.onLine) return;
  lastVersionCheck = Date.now();
  const version = await siteVersion().catch(() => null);
  if (!version) return;
  if (!loadedVersion) loadedVersion = version;
  else if (version !== loadedVersion) {
    updateReady = true;
    reloadIfQuiet();
  }
}

function quietForUpdate() {
  return !saveTimer && !saving && saveStateName !== 'unsaved' && saveStateName !== 'failed'
    && !pendingImageUploads && !pendingDeletes.size
    && !document.querySelector('.transfer-row .transfer-cancel')
    && !document.querySelector('.modal-backdrop:not([hidden])');
}

function reloadIfQuiet() {
  if (!updateReady || !quietForUpdate()) return;
  const hidden = document.visibilityState === 'hidden';
  // In front: only once it's been left alone a while (or just came back),
  // and never in the middle of signing in.
  const justBack = returnedAt && lastUseAt <= returnedAt && Date.now() - returnedAt < 10_000;
  if (!hidden && (!authScreen.hidden || (!justBack && Date.now() - lastUseAt < UPDATE_IDLE_MS))) return;
  let last = 0;
  try { last = Number(sessionStorage.getItem('updateReloadAt')) || 0; } catch {}
  if (Date.now() - last < UPDATE_RELOAD_GAP_MS) return;
  try { sessionStorage.setItem('updateReloadAt', String(Date.now())); } catch {}
  location.reload();
}

for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) {
  document.addEventListener(type, () => { lastUseAt = Date.now(); }, { capture: true, passive: true });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Gone to the background: reload once pending saves have gone out.
    setTimeout(reloadIfQuiet, 3000);
    return;
  }
  // Just back (and not touched yet): a waiting update, or one the check
  // finds now, applies right away.
  returnedAt = Date.now();
  lastUseAt = returnedAt;
  if (updateReady) reloadIfQuiet();
  else if (Date.now() - lastVersionCheck > UPDATE_RECHECK_MS) checkForUpdate();
});
setInterval(() => {
  if (updateReady) reloadIfQuiet();
  else if (document.visibilityState === 'visible' && Date.now() - lastVersionCheck > UPDATE_CHECK_MS) checkForUpdate();
}, 30_000);
checkForUpdate();

// Draw what this device kept from last time, then check who is signed in
// (which also renews the one-year cookie) and carry on from there.
const paintedEmail = await paintFromSnapshot();
const me = paintedEmail ? await whoAmI() : await rawFetch(API_AUTH, { cache:'no-store' }).catch(() => null);
if (me?.ok) {
  account = await me.json();
  if (paintedEmail && paintedEmail !== account.email) clearPainted();
  masterKey = account.keyring ? await vault.recallMaster(account.email) : null;
  if (masterKey) await startApp();
  else {
    if (paintedEmail) clearPainted();
    showUnlock();
  }
} else {
  if (paintedEmail) clearPainted();
  // Signed out (here or everywhere): this device forgets its keys.
  await vault.forgetKeys();
  // The emailed link opens straight at the code step.
  const params = new URLSearchParams(location.search);
  authEmail = params.get('email') || '';
  showAuth(params.get('step') === 'code' && authEmail ? 'code' : 'signin');
  if (params.has('step')) history.replaceState(null, '', '/');
}
