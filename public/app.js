const API_STATE = '/.netlify/functions/state';
const API_FILES = '/.netlify/functions/files';
const POLL_MS = 2000;
const SAVE_DELAY_MS = 450;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const PARALLEL_CHUNKS = 3;
const CHUNK_RETRIES = 3;
const LAST_SHEET_KEY = 'scratchpad:lastSheet';
const SHEET_COUNT = 5;
const DEFAULT_SHEET_NAMES = ['Sheet 1', 'Sheet 2', 'Sheet 3', 'Sheet 4', 'Sheet 5'];

const pad = document.querySelector('#scratchpad');
const statusEl = document.querySelector('#status');
const timestampEl = document.querySelector('#timestamp');
const copyBtn = document.querySelector('#copyBtn');
const clearBtn = document.querySelector('#clearBtn');
const fileInput = document.querySelector('#fileInput');
const fileList = document.querySelector('#fileList');
const transferList = document.querySelector('#transferList');
const emptyFiles = document.querySelector('#emptyFiles');
const dropZone = document.querySelector('#dropZone');
const toastEl = document.querySelector('#toast');
const sheetTabs = [...document.querySelectorAll('.sheet-tab')];
const filesSheetLabel = document.querySelector('#filesSheetLabel');
const renameSheetBtn = document.querySelector('#renameSheetBtn');
const renameModal = document.querySelector('#renameModal');
const renameForm = document.querySelector('#renameForm');
const renameInput = document.querySelector('#renameInput');
const previewModal = document.querySelector('#previewModal');
const previewBody = document.querySelector('#previewBody');
const previewTitle = document.querySelector('#previewTitle');
const previewSaveBtn = document.querySelector('#previewSaveBtn');

let activeSheet = 1;
let localUpdatedAt = 0;
let saveTimer = null;
let saving = false;
let lastInputAt = 0;
let lastFileRefresh = 0;
let sheetNames = [...DEFAULT_SHEET_NAMES];
let sheetNamesUpdatedAt = 0;
let previewObjectUrl = null;
let previewFile = null;
let previewLoadedFile = null;
let previewAbort = null;
let fileIndex = new Map();

function validSheet(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= SHEET_COUNT ? n : 1;
}

function currentSheetName(sheet = activeSheet) {
  return sheetNames[validSheet(sheet) - 1] || DEFAULT_SHEET_NAMES[validSheet(sheet) - 1];
}

function setStatus(mode, text) {
  statusEl.className = `status ${mode || ''}`.trim();
  statusEl.querySelector('span:last-child').textContent = text;
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function formatDate(ts) {
  if (!ts) return 'Not saved yet';
  return `Last updated ${new Intl.DateTimeFormat(undefined, { dateStyle:'medium', timeStyle:'short' }).format(new Date(ts))}`;
}

function stateUrl(sheet = activeSheet) {
  return `${API_STATE}?sheet=${validSheet(sheet)}`;
}

function namesUrl() {
  return `${API_STATE}?meta=names`;
}

function currentUrl() {
  return `${API_STATE}?meta=current`;
}

function rememberedSheet() {
  try {
    return validSheet(localStorage.getItem(LAST_SHEET_KEY));
  } catch {
    return null;
  }
}

async function fetchCurrentSheet() {
  try {
    const r = await fetch(currentUrl(), { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return validSheet((await r.json()).sheet);
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

function applySheetNames() {
  sheetTabs.forEach((tab, index) => {
    const label = tab.querySelector('.sheet-label');
    const name = sheetNames[index] || DEFAULT_SHEET_NAMES[index];
    label.textContent = name;
    tab.title = `${name} — double-click to rename`;
  });
  filesSheetLabel.textContent = currentSheetName();
}

async function fetchSheetNames() {
  try {
    const r = await fetch(namesUrl(), { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const remoteTs = Number(data.updatedAt || 0);
    if (remoteTs >= sheetNamesUpdatedAt && Array.isArray(data.names)) {
      sheetNames = DEFAULT_SHEET_NAMES.map((fallback, i) => {
        const value = String(data.names[i] ?? '').trim();
        return value || fallback;
      });
      sheetNamesUpdatedAt = remoteTs;
      applySheetNames();
    }
  } catch {
    // Sheet names fall back locally if metadata is temporarily unavailable.
  }
}

async function fetchState(sheet = activeSheet) {
  const requestedSheet = validSheet(sheet);
  try {
    const r = await fetch(stateUrl(requestedSheet), { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    if (requestedSheet !== activeSheet) return;

    const remoteTs = Number(data.updatedAt || 0);
    const recentlyTyping = Date.now() - lastInputAt < 850;

    if (remoteTs > localUpdatedAt && !saving && !recentlyTyping) {
      const selectionStart = pad.selectionStart;
      const selectionEnd = pad.selectionEnd;
      pad.value = data.text || '';
      localUpdatedAt = remoteTs;
      timestampEl.textContent = formatDate(localUpdatedAt);
      if (document.activeElement === pad) {
        const max = pad.value.length;
        pad.setSelectionRange(Math.min(selectionStart, max), Math.min(selectionEnd, max));
      }
    } else if (!localUpdatedAt && !saving && !saveTimer && !recentlyTyping) {
      pad.value = data.text || '';
      localUpdatedAt = remoteTs;
      timestampEl.textContent = formatDate(localUpdatedAt);
    }
    setStatus('live', 'Live');
  } catch (err) {
    if (requestedSheet === activeSheet) setStatus('error', 'Offline');
  }
}

async function saveState(sheet = activeSheet) {
  const targetSheet = validSheet(sheet);
  const textToSave = pad.value;
  saving = true;
  if (targetSheet === activeSheet) setStatus('', 'Saving…');
  try {
    const r = await fetch(stateUrl(targetSheet), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: textToSave })
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    if (targetSheet === activeSheet) {
      localUpdatedAt = Number(data.updatedAt || Date.now());
      timestampEl.textContent = formatDate(localUpdatedAt);
      setStatus('live', 'Saved');
    }
  } catch (err) {
    if (targetSheet === activeSheet) setStatus('error', 'Save failed');
  } finally {
    saving = false;
  }
}

pad.addEventListener('input', () => {
  lastInputAt = Date.now();
  clearTimeout(saveTimer);
  setStatus('', 'Unsaved');
  const sheetAtInput = activeSheet;
  saveTimer = setTimeout(() => { saveTimer = null; saveState(sheetAtInput); }, SAVE_DELAY_MS);
});

copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(pad.value);
  showToast('Copied');
});

clearBtn.addEventListener('click', () => {
  if (!pad.value || confirm(`Clear ${currentSheetName()} for everyone?`)) {
    pad.value = '';
    pad.dispatchEvent(new Event('input'));
  }
});

async function switchSheet(nextSheet, { remember = true } = {}) {
  nextSheet = validSheet(nextSheet);
  if (nextSheet === activeSheet) return;
  if (remember) rememberCurrentSheet(nextSheet);

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveState(activeSheet);
  }

  pad.readOnly = true;
  activeSheet = nextSheet;
  localUpdatedAt = 0;
  lastInputAt = 0;
  lastFileRefresh = 0;
  pad.value = '';
  fileList.innerHTML = '';
  fileIndex = new Map();
  emptyFiles.hidden = false;
  timestampEl.textContent = 'Loading…';
  filesSheetLabel.textContent = currentSheetName();

  for (const tab of sheetTabs) {
    const isActive = Number(tab.dataset.sheet) === activeSheet;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  }

  setStatus('', 'Loading…');
  await Promise.all([fetchState(activeSheet), loadFiles(true, activeSheet)]);
  pad.readOnly = false;
}

sheetTabs.forEach(tab => {
  tab.addEventListener('click', () => switchSheet(Number(tab.dataset.sheet)));
  tab.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const sheet = Number(tab.dataset.sheet);
    if (sheet !== activeSheet) switchSheet(sheet).then(openRenameModal);
    else openRenameModal();
  });
});

function openRenameModal() {
  renameInput.value = currentSheetName();
  renameModal.hidden = false;
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    renameInput.focus();
    renameInput.select();
  });
}

function closeRenameModal() {
  renameModal.hidden = true;
  if (previewModal.hidden) document.body.classList.remove('modal-open');
}

renameSheetBtn.addEventListener('click', openRenameModal);
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
    const r = await fetch(namesUrl(), {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ sheet:activeSheet, name })
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    sheetNames = DEFAULT_SHEET_NAMES.map((fallback, i) => String(data.names?.[i] || fallback));
    sheetNamesUpdatedAt = Number(data.updatedAt || Date.now());
    applySheetNames();
    closeRenameModal();
    showToast('Sheet renamed');
  } catch {
    showToast('Rename failed');
  }
});


function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(1)} MB`;
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

function createTransfer(name, verb, total) {
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
    done(text) {
      fill.style.width = '100%';
      finish('done', text);
    },
    fail(text) {
      finish('failed', text);
    }
  };
}

// ---- File list ----

async function loadFiles(force = false, sheet = activeSheet) {
  const requestedSheet = validSheet(sheet);
  if (!force && requestedSheet === activeSheet && Date.now() - lastFileRefresh < 1800) return;
  try {
    const r = await fetch(filesUrl(requestedSheet), { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (requestedSheet !== activeSheet) return;

    const files = Array.isArray(data.files) ? data.files : [];
    fileIndex = new Map(files.map(f => [f.id, { ...f, sheet: requestedSheet }]));
    fileList.innerHTML = files.map(f => {
      const id = escapeHtml(f.id);
      return `
      <div class="file-row">
        <div class="file-main">
          <button class="file-name" type="button" data-view="${id}">${escapeHtml(f.name)}</button>
          <div class="file-meta">${bytes(f.size || 0)} · ${new Date(f.uploadedAt).toLocaleString()}</div>
        </div>
        <div class="file-actions">
          <button class="icon-btn" type="button" data-save="${id}">Save</button>
          <button class="icon-btn delete" type="button" data-delete="${id}">Delete</button>
        </div>
      </div>`;
    }).join('');
    emptyFiles.hidden = files.length > 0;
    lastFileRefresh = Date.now();
  } catch (err) {
    // Keep text sync working even if file listing fails.
  }
}

// ---- Downloads ----

// Fetches one chunk, reporting bytes as they stream in.
async function fetchChunk(url, signal, onBytes) {
  const r = await fetch(url, { cache:'no-store', signal });
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
      return fetchChunk(filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}&chunk=${i}`), signal, n => {
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
      previewBody.innerHTML = '<div class="preview-fallback"><strong>File ready.</strong><span>Tap Save above, then choose Save to Files.</span></div>';
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
    fallback.innerHTML = '<strong>Preview is not available for this file type.</strong><span>Use Save to open the iPhone share sheet or download the file.</span>';
    previewBody.replaceChildren(fallback);
  } catch (err) {
    if (err?.name === 'AbortError' || previewAbort !== controller) return;
    previewBody.innerHTML = '<div class="preview-fallback"><strong>Could not load this file.</strong><span>Try Save instead.</span></div>';
  }
}

function closePreview() {
  previewAbort?.abort();
  previewAbort = null;
  previewModal.hidden = true;
  previewBody.innerHTML = '';
  previewFile = null;
  previewLoadedFile = null;
  clearPreviewObjectUrl();
  if (renameModal.hidden) document.body.classList.remove('modal-open');
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
    await saveSharedFile(previewFile);
  } catch (err) {
    if (err?.name !== 'AbortError') showToast('Could not save file');
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!previewModal.hidden) closePreview();
  else if (!renameModal.hidden) closeRenameModal();
});

fileList.addEventListener('click', async (e) => {
  const viewBtn = e.target.closest('[data-view]');
  if (viewBtn) {
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

  const deleteBtn = e.target.closest('[data-delete]');
  if (!deleteBtn) return;
  const file = fileIndex.get(deleteBtn.dataset.delete);
  if (!file || !confirm(`Delete ${file.name}?`)) return;
  deleteBtn.disabled = true;
  const r = await fetch(filesUrl(file.sheet, `id=${encodeURIComponent(file.id)}`), { method:'DELETE' }).catch(() => null);
  if (r?.ok) {
    showToast('File deleted');
    if (file.sheet === activeSheet) await loadFiles(true, file.sheet);
  } else {
    deleteBtn.disabled = false;
    showToast('Delete failed');
  }
});

// ---- Uploads ----

// Sends one chunk with XHR so the browser reports upload progress.
function putChunk(url, blob, signal, onBytes) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once:true });
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
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
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function uploadFile(file, targetSheet, transfer) {
  let id = null;
  try {
    const start = await postJson(filesUrl(targetSheet, 'action=start'), { name:file.name, type:file.type, size:file.size });
    id = start.id;
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
    await postJson(filesUrl(targetSheet, `id=${encodeURIComponent(id)}&action=finish`));
    transfer.done(`Uploaded to ${currentSheetName(targetSheet)} · ${bytes(file.size)}`);
    return true;
  } catch (err) {
    if (id) fetch(filesUrl(targetSheet, `id=${encodeURIComponent(id)}`), { method:'DELETE' }).catch(() => {});
    transfer.fail(err?.name === 'AbortError' ? 'Upload cancelled' : 'Upload failed');
    return false;
  }
}

async function uploadFiles(files) {
  const targetSheet = activeSheet;
  fileInput.value = '';
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

fileInput.addEventListener('change', () => uploadFiles([...fileInput.files]));
['dragenter','dragover'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave','drop'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.addEventListener('drop', e => uploadFiles([...e.dataTransfer.files]));
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

// Leaving the page: save any pending edit right away.
// Coming back: jump to whichever sheet was last opened on any device.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saveState(activeSheet);
    }
    return;
  }
  const sheet = await fetchCurrentSheet();
  if (sheet && sheet !== activeSheet && !saveTimer && !saving) await switchSheet(sheet, { remember:false });
});

await fetchSheetNames();
const startSheet = (await fetchCurrentSheet()) || rememberedSheet() || 1;
if (startSheet !== activeSheet) {
  await switchSheet(startSheet, { remember:false });
} else {
  await fetchState(activeSheet);
  await loadFiles(true, activeSheet);
}

setInterval(() => {
  fetchState(activeSheet);
  fetchSheetNames();
  loadFiles(false, activeSheet);
}, POLL_MS);
