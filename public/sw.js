// ScrapSheet's service worker. It does one thing: receive what's shared to
// ScrapSheet from another app (Android's Share menu, via share_target in the
// manifest). Everything else goes straight to the network as before: nothing
// is cached here.
//
// Shared files and text never go to the server from here. They're kept on
// this device (IndexedDB, 'scratchpad-share') until the page picks them up,
// locks them with the sheet's key and uploads them like any other file.

const DB = 'scratchpad-share';
const STORE = 'inbox';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.origin === location.origin && url.pathname === '/share-target') {
    event.respondWith(receiveShare(event.request));
  }
});

function openInbox() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter(f => f instanceof File && f.size > 0);
    // Apps fill title, text and url differently; keep each distinct line once.
    const lines = [];
    for (const key of ['title', 'text', 'url']) {
      for (const line of String(form.get(key) || '').split('\n').map(l => l.trim())) {
        if (line && !lines.includes(line)) lines.push(line);
      }
    }
    if (files.length || lines.length) {
      const db = await openInbox();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).add({ files, text: lines.join('\n'), at: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }
  } catch {
    // Nothing usable came through; ScrapSheet still opens.
  }
  return Response.redirect('/?shared=1', 303);
}
