const API_STATE = '/.netlify/functions/state';
const API_FILES = '/.netlify/functions/files';
const API_IMAGES = '/.netlify/functions/images';
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
const filesHint = document.querySelector('#filesHint');
const selectBtn = document.querySelector('#selectBtn');
const uploadBtn = document.querySelector('#uploadBtn');
const selectBar = document.querySelector('#selectBar');
const selectAllBtn = document.querySelector('#selectAllBtn');
const selectTotal = document.querySelector('#selectTotal');
const bulkBar = document.querySelector('#bulkBar');
const bulkCount = document.querySelector('#bulkCount');
const bulkSize = document.querySelector('#bulkSize');
const bulkSaveBtn = document.querySelector('#bulkSaveBtn');
const bulkDeleteBtn = document.querySelector('#bulkDeleteBtn');
const sheetModal = document.querySelector('#sheetModal');
const sheetTitle = document.querySelector('#sheetTitle');
const sheetText = document.querySelector('#sheetText');
const sheetItems = document.querySelector('#sheetItems');
const sheetActions = document.querySelector('#sheetActions');
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
let sheetNames = [...DEFAULT_SHEET_NAMES];
let sheetNamesUpdatedAt = 0;
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

    const busy = saving || recentlyTyping || resizingImage || pendingImageUploads > 0;
    const remoteHtml = typeof data.html === 'string' ? data.html : textToHtml(data.text || '');

    if (remoteTs > localUpdatedAt && !busy) {
      renderEditor(remoteHtml);
      localUpdatedAt = remoteTs;
      timestampEl.textContent = formatDate(localUpdatedAt);
    } else if (!localUpdatedAt && !busy && !saveTimer) {
      renderEditor(remoteHtml);
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
  const textToSave = pad.innerText;
  const htmlToSave = serializeEditor();
  saving = true;
  if (targetSheet === activeSheet) setStatus('', 'Saving…');
  try {
    const r = await fetch(stateUrl(targetSheet), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: textToSave, html: htmlToSave })
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

// Called after anything changes the editor's content.
function onEditorChanged() {
  lastInputAt = Date.now();
  updateEmptyState();
  clearTimeout(saveTimer);
  setStatus('', 'Unsaved');
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

clearBtn.addEventListener('click', () => {
  if (editorIsEmpty() || confirm(`Clear ${currentSheetName()} for everyone?`)) {
    pad.replaceChildren();
    onEditorChanged();
  }
});

// ---- Editor content: text plus this site's own images ----

const PAD_IMAGE_SRC = /^\/\.netlify\/functions\/images\?sheet=[1-5]&id=[A-Za-z0-9-]{1,64}$/;
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
  } catch (err) {
    img.remove();
    if (transfer) transfer.fail(err?.name === 'AbortError' ? 'Upload cancelled' : 'Image upload failed');
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

async function switchSheet(nextSheet, { remember = true } = {}) {
  nextSheet = validSheet(nextSheet);
  if (nextSheet === activeSheet) return;
  if (pendingImageUploads) {
    showToast('Wait for images to finish uploading');
    return;
  }
  if (remember) rememberCurrentSheet(nextSheet);

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveState(activeSheet);
  }

  pad.contentEditable = 'false';
  activeSheet = nextSheet;
  localUpdatedAt = 0;
  lastInputAt = 0;
  lastFileRefresh = 0;
  deselectImage();
  pad.replaceChildren();
  updateEmptyState();
  setSelecting(false);
  fileList.innerHTML = '';
  fileIndex = new Map();
  currentFiles = [];
  filesSignature = '';
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
  pad.contentEditable = 'true';
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
    lastFileRefresh = Date.now();
    const signature = JSON.stringify(files);
    if (signature === filesSignature) return;
    filesSignature = signature;
    currentFiles = files.map(f => ({ ...f, sheet: requestedSheet }));
    fileIndex = new Map(currentFiles.map(f => [f.id, f]));
    for (const id of selectedIds) if (!fileIndex.has(id)) selectedIds.delete(id);
    if (!currentFiles.length) setSelecting(false);
    renderFiles();
  } catch (err) {
    // Keep text sync working even if file listing fails.
  }
}

function renderFiles() {
  fileList.innerHTML = currentFiles.map(f => {
    const id = escapeHtml(f.id);
    const meta = `${bytes(f.size || 0)} · ${new Date(f.uploadedAt).toLocaleString()}`;
    if (selecting) {
      const checked = selectedIds.has(f.id);
      return `
      <label class="file-row selectable${checked ? ' selected' : ''}">
        <input type="checkbox" data-select="${id}"${checked ? ' checked' : ''} />
        <span class="file-main">
          <span class="file-title">${escapeHtml(f.name)}</span>
          <span class="file-meta">${meta}</span>
        </span>
      </label>`;
    }
    return `
      <div class="file-row">
        <div class="file-main">
          <button class="file-name" type="button" data-view="${id}">${escapeHtml(f.name)}</button>
          <div class="file-meta">${meta}</div>
        </div>
        <div class="file-actions">
          <button class="icon-btn" type="button" data-save="${id}">Save</button>
          <button class="icon-btn delete" type="button" data-delete="${id}">Delete</button>
        </div>
      </div>`;
  }).join('');
  emptyFiles.hidden = currentFiles.length > 0;
  selectBtn.hidden = !currentFiles.length;
  updateSelectionUi();
}

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

function updateSelectionUi() {
  const files = selectedFiles();
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
  selectBtn.textContent = selecting ? 'Done' : 'Select';
  uploadBtn.hidden = selecting;
  filesHint.textContent = selecting ? 'Tap files to select them.' : 'Files are organized by sheet. Share any file up to 100 MB.';
  selectBar.hidden = !selecting;
  bulkBar.hidden = !selecting;
  const all = currentFiles.length > 0 && files.length === currentFiles.length;
  selectAllBtn.textContent = all ? 'Clear selection' : 'Select all';
  selectTotal.textContent = `${currentFiles.length} file${currentFiles.length === 1 ? '' : 's'}`;
  bulkCount.textContent = `${files.length} selected`;
  bulkSize.textContent = files.length ? ` · ${bytes(total)}` : '';
  bulkSaveBtn.disabled = bulkDeleteBtn.disabled = !files.length;
  bulkSaveBtn.textContent = files.length ? `Save ${files.length}` : 'Save';
  bulkDeleteBtn.textContent = files.length ? `Delete ${files.length}` : 'Delete';
}

selectBtn.addEventListener('click', () => setSelecting(!selecting));

selectAllBtn.addEventListener('click', () => {
  selectedIds = selectedIds.size === currentFiles.length ? new Set() : new Set(currentFiles.map(f => f.id));
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
  sheetModal.hidden = false;
  document.body.classList.add('modal-open');
}

function closeSheet() {
  sheetModal.hidden = true;
  if (renameModal.hidden && previewModal.hidden) document.body.classList.remove('modal-open');
}

sheetModal.addEventListener('click', e => { if (e.target === sheetModal) closeSheet(); });

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
    showToast('Could not save image');
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
    if (err?.name !== 'AbortError') showToast('Could not save file');
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!sheetModal.hidden) closeSheet();
  else if (!previewModal.hidden) closePreview();
  else if (!renameModal.hidden) closeRenameModal();
  else if (selecting) setSelecting(false);
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
  const transfer = createTransfer(`Saving ${count}${asZip ? ' as .zip' : ''}`, 'Downloading', total, files.map(f => f.name));
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
    transfer.fail(err?.name === 'AbortError' ? 'Save cancelled' : 'Save failed');
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
    title: `Save ${files.length} files`,
    text: `${bytes(total)} total. Save them one by one, or bundled into a single .zip file.`,
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
          setStatus('', 'Deleting…');
          const results = await Promise.all(files.map(f =>
            fetch(filesUrl(f.sheet, `id=${encodeURIComponent(f.id)}`), { method:'DELETE' }).then(r => r.ok).catch(() => false)
          ));
          const failed = results.filter(ok => !ok).length;
          setStatus('live', 'Live');
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
