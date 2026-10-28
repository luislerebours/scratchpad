const API_STATE = '/.netlify/functions/state';
const API_FILES = '/.netlify/functions/files';
const POLL_MS = 2000;
const SAVE_DELAY_MS = 450;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SHEET_COUNT = 5;
const DEFAULT_SHEET_NAMES = ['Sheet 1', 'Sheet 2', 'Sheet 3', 'Sheet 4', 'Sheet 5'];

const pad = document.querySelector('#scratchpad');
const statusEl = document.querySelector('#status');
const timestampEl = document.querySelector('#timestamp');
const copyBtn = document.querySelector('#copyBtn');
const clearBtn = document.querySelector('#clearBtn');
const fileInput = document.querySelector('#fileInput');
const fileList = document.querySelector('#fileList');
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

async function switchSheet(nextSheet) {
  nextSheet = validSheet(nextSheet);
  if (nextSheet === activeSheet) return;

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

async function loadFiles(force = false, sheet = activeSheet) {
  const requestedSheet = validSheet(sheet);
  if (!force && requestedSheet === activeSheet && Date.now() - lastFileRefresh < 1800) return;
  try {
    const r = await fetch(filesUrl(requestedSheet), { cache:'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (requestedSheet !== activeSheet) return;

    const files = Array.isArray(data.files) ? data.files : [];
    fileList.innerHTML = files.map(f => {
      const id = encodeURIComponent(f.id);
      const sheet = validSheet(f.sheet || requestedSheet);
      const name = escapeHtml(f.name);
      const type = escapeHtml(f.type || 'application/octet-stream');
      return `
      <div class="file-row">
        <div class="file-main">
          <button class="file-name" type="button" data-view="${id}" data-sheet="${sheet}" data-name="${name}" data-type="${type}">${name}</button>
          <div class="file-meta">${bytes(f.size || 0)} · ${new Date(f.uploadedAt).toLocaleString()}</div>
        </div>
        <div class="file-actions">
          <button class="icon-btn" type="button" data-save="${id}" data-sheet="${sheet}" data-name="${name}" data-type="${type}">Save</button>
          <button class="icon-btn delete" type="button" data-delete="${escapeHtml(f.id)}" data-sheet="${sheet}">Delete</button>
        </div>
      </div>`;
    }).join('');
    emptyFiles.hidden = files.length > 0;
    lastFileRefresh = Date.now();
  } catch (err) {
    // Keep text sync working even if file listing fails.
  }
}

async function fetchSharedFile(sheet, encodedId, name, type) {
  const r = await fetch(filesUrl(sheet, `id=${encodedId}&download=1`), { cache:'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  return new File([blob], name || 'file', { type: type || blob.type || 'application/octet-stream' });
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

async function saveSharedFile(sheet, encodedId, name, type) {
  try {
    showToast('Preparing file…');
    const file = await fetchSharedFile(sheet, encodedId, name, type);

    if (isIOS()) {
      // Try the native share sheet immediately. If iOS has already consumed the
      // original tap while the file was loading, keep the prepared File in memory
      // and show an in-app screen. A second tap on Save then opens Share reliably.
      try {
        if (await sharePreparedFile(file)) return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }

      previewFile = { sheet, encodedId, name, type };
      previewLoadedFile = file;
      previewTitle.textContent = name || 'File';
      previewBody.innerHTML = '<div class="preview-fallback"><strong>File ready.</strong><span>Tap Save above, then choose Save to Files.</span></div>';
      previewModal.hidden = false;
      document.body.classList.add('modal-open');
      return;
    }

    downloadPreparedFile(file);
  } catch (err) {
    if (err?.name !== 'AbortError') showToast('Could not save file');
  }
}

function clearPreviewObjectUrl() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
}

async function openPreview(sheet, encodedId, name, type) {
  clearPreviewObjectUrl();
  previewFile = { sheet, encodedId, name, type };
  previewLoadedFile = null;
  previewTitle.textContent = name || 'File';
  previewBody.innerHTML = '<div class="preview-loading">Loading preview…</div>';
  previewModal.hidden = false;
  document.body.classList.add('modal-open');

  try {
    const file = await fetchSharedFile(sheet, encodedId, name, type);
    previewLoadedFile = file;
    previewObjectUrl = URL.createObjectURL(file);
    const mime = file.type || type || '';

    if (mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'preview-image';
      img.alt = name || 'File preview';
      img.src = previewObjectUrl;
      previewBody.replaceChildren(img);
      return;
    }

    if (mime === 'application/pdf' || String(name).toLowerCase().endsWith('.pdf')) {
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
  } catch {
    previewBody.innerHTML = '<div class="preview-fallback"><strong>Could not load this file.</strong><span>Try Save instead.</span></div>';
  }
}

function closePreview() {
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
    await saveSharedFile(previewFile.sheet, previewFile.encodedId, previewFile.name, previewFile.type);
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
    await openPreview(validSheet(viewBtn.dataset.sheet), viewBtn.dataset.view, viewBtn.dataset.name, viewBtn.dataset.type);
    return;
  }

  const saveBtn = e.target.closest('[data-save]');
  if (saveBtn) {
    saveBtn.disabled = true;
    await saveSharedFile(validSheet(saveBtn.dataset.sheet), saveBtn.dataset.save, saveBtn.dataset.name, saveBtn.dataset.type);
    saveBtn.disabled = false;
    return;
  }

  const deleteBtn = e.target.closest('[data-delete]');
  if (!deleteBtn) return;
  if (!confirm('Delete this shared file?')) return;
  deleteBtn.disabled = true;
  const sheet = validSheet(deleteBtn.dataset.sheet || activeSheet);
  const r = await fetch(filesUrl(sheet, `id=${encodeURIComponent(deleteBtn.dataset.delete)}`), { method:'DELETE' });
  if (r.ok) {
    showToast('File deleted');
    if (sheet === activeSheet) await loadFiles(true, sheet);
  } else {
    deleteBtn.disabled = false;
    showToast('Delete failed');
  }
});

async function uploadFiles(files) {
  const targetSheet = activeSheet;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      showToast(`${file.name} is over 4 MB`);
      continue;
    }
    const form = new FormData();
    form.append('file', file, file.name);
    if (targetSheet === activeSheet) setStatus('', 'Uploading…');
    try {
      const r = await fetch(filesUrl(targetSheet), { method:'POST', body:form });
      if (!r.ok) throw new Error(await r.text());
      showToast(`Uploaded to ${currentSheetName(targetSheet)}`);
    } catch (err) {
      showToast('Upload failed');
    }
  }
  if (targetSheet === activeSheet) setStatus('live', 'Live');
  fileInput.value = '';
  if (targetSheet === activeSheet) await loadFiles(true, targetSheet);
}

fileInput.addEventListener('change', () => uploadFiles([...fileInput.files]));
['dragenter','dragover'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave','drop'].forEach(evt => dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.addEventListener('drop', e => uploadFiles([...e.dataTransfer.files]));
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

await fetchSheetNames();
await fetchState(activeSheet);
await loadFiles(true, activeSheet);

setInterval(() => {
  fetchState(activeSheet);
  fetchSheetNames();
  loadFiles(false, activeSheet);
}, POLL_MS);
