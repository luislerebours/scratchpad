// The page someone sees when they open a share link: /s/<token>.
// No account needed; everything comes through the link's token. What's shared
// is locked; its key is after "#" in the link, which browsers never send anywhere.

import * as vault from '/crypto.js';

const API = '/.netlify/functions/share';
const token = decodeURIComponent((location.pathname.match(/^\/s\/([^/]+)/) || [])[1] || new URLSearchParams(location.search).get('t') || '');
const card = document.querySelector('#shareCard');
const toastEl = document.querySelector('#toast');
const PARALLEL = 3;
const fragment = location.hash.slice(1);
let itemKey = null; // the shared file's or sheet's key, from the link
// A link with a password: the pass from unlocking it goes with every request,
// and the key inside the link ("p.<salt>.<locked key>") opens with the password.
let pass = '';
const shareApi = () => `${API}?t=${encodeURIComponent(token)}${pass ? `&p=${encodeURIComponent(pass)}` : ''}`;
const fileKeys = new Map();

// A file's key: the link's own key for a shared file, or unwrapped with the sheet's key.
async function keyOf(file) {
  if (!file.enc) return null;
  if (!fileKeys.has(file.id)) fileKeys.set(file.id, file.shared ? Promise.resolve(itemKey) : vault.unwrap(file.key, itemKey, false));
  return fileKeys.get(file.id);
}

async function lockedBlob(url, key, type) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Not found');
  const data = new Uint8Array(await r.arrayBuffer());
  const sealed = r.headers.get('X-Sealed') === '1' || r.headers.get('Content-Type') === 'application/octet-stream';
  if (!key || !sealed) return new Blob([data], { type: type || r.headers.get('Content-Type') || '' });
  const shownAs = await vault.decryptText(key, r.headers.get('X-Image-Type') || '').catch(() => '');
  return new Blob([await vault.decryptBytes(key, data)], { type: shownAs || type || '' });
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function expiresText(at) {
  const ms = at - Date.now();
  const hours = ms / 3_600_000;
  if (hours < 1) return `Expires in ${Math.max(1, Math.round(ms / 60000))} min`;
  if (hours < 24) {
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
    return new Date(at).toDateString() === new Date().toDateString() ? `Expires today at ${time}` : `Expires tomorrow at ${time}`;
  }
  const days = Math.round(hours / 24);
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

const ICON = {
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  landscape: '<path d="M2.5 19 8.5 11l4.5 5.5 3-3.5 5.5 6z" fill="currentColor" stroke="none"/><circle cx="16.5" cy="7.5" r="2.2" fill="currentColor" stroke="none"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  broken: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2M4 4l16 16"/>'
};
const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

function fileKind(f) {
  const ext = (String(f.name).split('.').pop() || '').toLowerCase();
  const type = f.type || '';
  if (type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif'].includes(ext)) return ['img', ''];
  if (type === 'application/pdf' || ext === 'pdf') return ['pdf', 'PDF'];
  if (['xls', 'xlsx', 'xlsm', 'numbers', 'ods', 'csv'].includes(ext)) return ['sheet', ext === 'csv' ? 'CSV' : 'XLS'];
  if (['doc', 'docx', 'pages', 'rtf', 'odt'].includes(ext)) return ['doc', 'DOC'];
  if (['ppt', 'pptx', 'key', 'odp'].includes(ext)) return ['slides', 'PPT'];
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return ['zip', 'ZIP'];
  if (type.startsWith('video/') || ['mov', 'mp4', 'm4v', 'webm'].includes(ext)) return ['video', 'VID'];
  if (type.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'aac'].includes(ext)) return ['audio', 'AUD'];
  if (type.startsWith('text/') || ['txt', 'md', 'json', 'log'].includes(ext)) return ['text', 'TXT'];
  return ['file', ext && ext.length <= 4 ? ext.toUpperCase() : 'FILE'];
}

function fileIconHtml(f, big = false) {
  const [kind, label] = fileKind(f);
  const size = big ? ' big' : '';
  if (kind === 'img' && f.thumb && f.enc) {
    return `<span class="file-icon kind-img has-thumb${size}" aria-hidden="true"><img data-thumb="${escapeHtml(f.id)}" alt="" /></span>`;
  }
  if (kind === 'img' && f.thumb) {
    return `<span class="file-icon kind-img has-thumb${size}" aria-hidden="true"><img src="${shareApi()}&thumb=${encodeURIComponent(f.id)}" alt="" /></span>`;
  }
  return `<span class="file-icon kind-${kind}${size}" aria-hidden="true">${kind === 'img' ? icon('landscape') : escapeHtml(label)}</span>`;
}

function fillThumbs(files) {
  for (const img of card.querySelectorAll('img[data-thumb]')) {
    const f = files.find(x => x.id === img.dataset.thumb);
    if (!f) continue;
    keyOf(f)
      .then(key => lockedBlob(`${shareApi()}&thumb=${encodeURIComponent(f.id)}`, key, f.thumb.type))
      .then(blob => { img.src = URL.createObjectURL(blob); })
      .catch(() => img.remove());
  }
}

// ---- Downloading: a file arrives in 4 MB pieces, a few at a time ----

// Pieces stored in R2 come from the relay (a redirect). On a network that
// blocks it, they come through Netlify instead (`via=netlify`).
let viaNetlify = false;
async function fetchPiece(url) {
  if (viaNetlify) return fetch(`${url}&via=netlify`);
  try {
    return await fetch(url);
  } catch (err) {
    if (!navigator.onLine) throw err;
    const r = await fetch(`${url}&via=netlify`);
    viaNetlify = true;
    return r;
  }
}

async function fetchFile(file, onProgress) {
  const parts = new Array(file.chunks);
  let got = 0;
  let next = 0;
  const key = await keyOf(file);
  const worker = async () => {
    while (next < file.chunks) {
      const i = next++;
      const r = await fetchPiece(`${shareApi()}&file=${encodeURIComponent(file.id)}&chunk=${i}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The download stopped. Try again.');
      const piece = await r.arrayBuffer();
      parts[i] = key ? await vault.decryptBytes(key, piece) : piece;
      got += parts[i].byteLength;
      onProgress(file.size ? got / file.size : 1);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, file.chunks) }, worker));
  return new Blob(parts, { type: file.type || 'application/octet-stream' });
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// A download button that shows its own progress.
function wireDownload(button, file) {
  const label = button.querySelector('.dl-label');
  const bar = button.parentElement.querySelector('.dl-bar i');
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    const before = label?.textContent;
    try {
      const blob = await fetchFile(file, share => {
        if (bar) bar.style.width = `${Math.round(share * 100)}%`;
        if (label) label.textContent = `Downloading… ${Math.round(share * 100)}%`;
      });
      saveBlob(blob, file.name);
      if (label) label.textContent = 'Downloaded';
    } catch (err) {
      showToast(err.message);
      if (label) label.textContent = before;
    } finally {
      button.disabled = false;
      setTimeout(() => { if (bar) bar.style.width = '0'; if (label) label.textContent = before; }, 2500);
    }
  });
}

// ---- A shared sheet's text: only text, line breaks and the sheet's own images ----

const IMAGE_SRC = /^\/\.netlify\/functions\/images\?sheet=(?:[1-9]|10)&id=([A-Za-z0-9-]{1,64})$/;
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TR', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);
const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'SVG', 'MATH', 'HEAD', 'TITLE', 'META', 'LINK', 'VIDEO', 'AUDIO', 'CANVAS', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

function appendClean(source, target) {
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
      const match = IMAGE_SRC.exec(node.getAttribute('data-src') || node.getAttribute('src') || '');
      if (!match) continue;
      const img = document.createElement('img');
      const url = `${shareApi()}&image=${encodeURIComponent(match[1])}`;
      if (itemKey) {
        lockedBlob(url, itemKey).then(blob => { img.src = URL.createObjectURL(blob); }).catch(() => img.remove());
      } else {
        img.src = url;
      }
      img.alt = 'Image';
      if (!itemKey) img.loading = 'lazy';
      img.className = 'shared-image';
      const width = Math.round(Number(node.getAttribute('data-width')));
      if (Number.isFinite(width) && width > 0) img.style.width = `${Math.min(100, Math.max(10, width))}%`;
      target.append(img);
    } else if (BLOCK_TAGS.has(tag)) {
      const div = document.createElement('div');
      appendClean(node, div);
      target.append(div);
    } else {
      appendClean(node, target);
    }
  }
}

function renderSheetText(data, box) {
  if (data.html !== null && data.html !== undefined) {
    // Parsed inert: nothing in it runs or loads until copied over cleanly.
    const doc = new DOMParser().parseFromString(`<!doctype html><body>${data.html}`, 'text/html');
    appendClean(doc.body, box);
  } else {
    box.textContent = data.text || '';
  }
  if (!box.textContent.trim() && !box.querySelector('img')) {
    box.classList.add('is-empty');
    box.textContent = 'This sheet has no text.';
  }
}

// ---- Pages ----

function header(kicker, name, meta) {
  document.title = `${name} · ScrapSheet`;
  return `<p class="share-kicker">${escapeHtml(kicker)}</p>
    <h1 class="share-title">${escapeHtml(name)}</h1>
    <p class="share-meta">${meta}</p>`;
}

function renderFile(data) {
  const f = data.file;
  const [kind] = fileKind(f);
  const canPreview = kind === 'img' && f.size <= 12 * 1000 * 1000 && !/heic|heif/i.test(f.type || f.name);
  card.innerHTML = `
    ${header('Shared file', data.name, `${bytes(f.size)} · ${escapeHtml(expiresText(data.expiresAt))}`)}
    <div class="share-preview">${canPreview ? '<p class="share-loading">Loading preview…</p>' : fileIconHtml(f, true)}</div>
    <div class="dl">
      <button class="btn dl-main" type="button">${icon('download')}<span class="dl-label">Download</span></button>
      <div class="dl-bar" aria-hidden="true"><i></i></div>
    </div>`;
  wireDownload(card.querySelector('.dl-main'), f);
  fillThumbs([f]);
  if (canPreview) {
    fetchFile(f, () => {}).then(blob => {
      const img = document.createElement('img');
      img.alt = data.name;
      img.src = URL.createObjectURL(blob);
      card.querySelector('.share-preview').replaceChildren(img);
    }).catch(() => {
      card.querySelector('.share-preview').innerHTML = fileIconHtml(f, true);
    });
  }
}

function renderSheet(data) {
  const n = data.files.length;
  const meta = `${n ? `${n} file${n === 1 ? '' : 's'} · ` : ''}${escapeHtml(expiresText(data.expiresAt))}`;
  card.innerHTML = `
    ${header('Shared sheet', data.name, meta)}
    <div class="share-text-wrap">
      <button class="ghost-btn share-copy" type="button">${icon('copy')}<span>Copy text</span></button>
      <div class="share-text" id="shareText"></div>
    </div>
    ${n ? `<h2 class="share-files-title">Files</h2>
    <div class="share-files">${data.files.map((f, i) => `
      <div class="share-file">
        ${fileIconHtml(f)}
        <div class="share-file-main"><div class="share-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div><div class="share-file-meta">${bytes(f.size || 0)}</div></div>
        <div class="dl">
          <button class="icon-btn dl-row" type="button" data-i="${i}" aria-label="Download ${escapeHtml(f.name)}">${icon('download')}<span class="dl-label sr-only">Download</span></button>
          <div class="dl-bar" aria-hidden="true"><i></i></div>
        </div>
      </div>`).join('')}
    </div>` : ''}`;
  const box = card.querySelector('#shareText');
  renderSheetText(data, box);
  fillThumbs(data.files);
  card.querySelectorAll('.dl-row').forEach(btn => wireDownload(btn, data.files[Number(btn.dataset.i)]));
  card.querySelector('.share-copy').addEventListener('click', async () => {
    const text = box.innerText;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(box);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      showToast('Selected: copy it from here');
    }
  });
}

function renderProblem(reason, message) {
  document.title = 'ScrapSheet';
  const advice = {
    expired: 'Ask the person who shared it for a new link.',
    off: 'The person who shared it turned this link off.',
    gone: 'It was deleted by the person who shared it.',
    missing: 'Check that the whole link was copied.',
    key: 'Check that the whole link was copied, including the part after “#”.'
  }[reason] || 'Check your connection and try again.';
  card.innerHTML = `<div class="share-problem">
      <span class="share-problem-mark" aria-hidden="true">${icon('broken')}</span>
      <h1 class="share-title">${escapeHtml(message)}</h1>
      <p class="share-meta">${escapeHtml(advice)}</p>
    </div>`;
}

// Unlocks what the server sent, in place. False if it's locked and the link's key doesn't open it.
async function unlock(data) {
  const sealedName = vault.isSealed(data.name);
  const locked = sealedName || vault.isSealed(data.html) || data.file?.enc || data.files?.some(f => f.enc);
  if (!locked) return true;
  try {
    itemKey = itemKey || await vault.importKey(fragment, false);
    data.name = await vault.decryptText(itemKey, data.name);
    if (data.kind === 'file') {
      data.file = { ...data.file, shared: true, name: await vault.decryptText(itemKey, data.file.name), type: await vault.decryptText(itemKey, data.file.type) };
    } else {
      data.html = data.html == null ? data.html : await vault.decryptText(itemKey, data.html);
      data.files = await Promise.all(data.files.map(async f => {
        if (!f.enc) return f;
        const key = await keyOf(f);
        return { ...f, name: await vault.decryptText(key, f.name), type: await vault.decryptText(key, f.type) };
      }));
    }
    return true;
  } catch {
    return false;
  }
}

// `local`: the server no longer asks for a password (it was removed, by an older
// version of the app, after this link was sent), but this link's key is still
// locked with it, so the password is checked here by whether it opens the key.
// `bound`: the password was changed after the link was made; the key comes from
// the server, locked with the new password and this link's part after "#".
function renderPassword(salt, local = false, bound = false) {
  document.title = 'ScrapSheet';
  const foot = document.querySelector('#shareFootText');
  if (foot) foot.textContent = 'Anyone with this link and its password can view and download what’s here until it expires.';
  card.innerHTML = `
    <form class="share-problem share-password" id="sharePwForm" novalidate>
      <span class="share-problem-mark" aria-hidden="true">${icon('lock')}</span>
      <h1 class="share-title">This link needs a password</h1>
      <p class="share-meta">Enter the password you were given with the link.</p>
      <input id="sharePw" class="rename-input" type="password" autocomplete="off" aria-label="Password" />
      <p class="auth-error" id="sharePwError" role="alert"></p>
      <button class="btn full" type="submit">Open</button>
    </form>`;
  const form = card.querySelector('#sharePwForm');
  const input = form.querySelector('#sharePw');
  const error = form.querySelector('#sharePwError');
  const button = form.querySelector('button');
  input.focus();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    error.textContent = '';
    if (!input.value) return void (error.textContent = 'Enter the password.');
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const { proof, kek } = await vault.linkPasswordKeys(bound ? `${input.value}\n${fragment}` : input.value, salt);
      if (local) {
        try {
          itemKey = await vault.unwrap(fragment.split('.')[2], kek, false);
        } catch {
          throw new Error('That password isn’t right.');
        }
        start();
        return;
      }
      const r = await fetch(`${API}?t=${encodeURIComponent(token)}&action=unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'That password isn’t right.');
      pass = data.pass;
      if (bound) {
        try {
          itemKey = await vault.unwrap(data.wrapped, kek, false);
        } catch {
          pass = '';
          throw new Error('This link doesn’t match its password. Check that the whole link was copied.');
        }
        start();
        return;
      }
      // The key in the link is locked with the password.
      const [kind, , locked] = fragment.split('.');
      if (kind === 'p') {
        try {
          itemKey = await vault.unwrap(locked, kek, false);
        } catch {
          pass = '';
          throw new Error('This link is out of date: its password was changed. Ask for the new link.');
        }
      }
      start();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      button.textContent = 'Open';
      input.select();
    }
  });
}

// A phone sends a new link the moment it's made, while it's still being saved,
// so a link not found yet is asked for again for a few seconds.
const NOT_YET_TRIES = 5;
const NOT_YET_WAIT_MS = 1500;
let notYet = 0;

async function start() {
  if (!token) {
    renderProblem('missing', 'This link doesn’t work.');
    return;
  }
  try {
    const r = await fetch(`${shareApi()}`, { cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 404 && data.reason === 'missing' && ++notYet < NOT_YET_TRIES) {
      setTimeout(start, NOT_YET_WAIT_MS);
      return;
    }
    if (r.status === 401 && data.reason === 'password') {
      // Its key comes after "#": without that part the password couldn't
      // open anything, so say so before asking for it.
      if (!fragment) {
        renderProblem('key', 'This link is missing its key.');
        return;
      }
      renderPassword(data.salt, false, Boolean(data.bound) && fragment.startsWith('p.'));
      return;
    }
    if (!r.ok) {
      renderProblem(data.reason, data.error || 'This link doesn’t work.');
      return;
    }
    // A link made with a password, whose password was since removed.
    const [kind, salt, locked] = fragment.split('.');
    if (kind === 'p' && salt && locked && !itemKey && data.rekey) {
      // Removed: the key is kept locked with this link's part alone.
      try {
        const { kek } = await vault.linkPasswordKeys(`\n${fragment}`, data.rekey.salt);
        itemKey = await vault.unwrap(data.rekey.wrapped, kek, false);
      } catch {
        renderProblem('key', 'This link is missing its key.');
        return;
      }
    } else if (kind === 'p' && salt && locked && !itemKey) {
      renderPassword(salt, true);
      return;
    }
    if (!(await unlock(data))) {
      renderProblem('key', 'This link is missing its key.');
      return;
    }
    if (data.kind === 'file') renderFile(data);
    else renderSheet(data);
  } catch {
    renderProblem('network', 'Couldn’t open this link.');
  }
}

// A different link opened in this tab (only the part after "#" changed): start over with it.
window.addEventListener('hashchange', () => location.reload());

start();
