import { DurableObject } from 'cloudflare:workers';

// Real-time relay for Scratch Pad, and the way file pieces reach R2 (see
// files() below). Each account has a room; its open devices
// hold a WebSocket to it, and Netlify posts a signed notice to /notify after
// every change, which the room passes to every device. Connection passes and
// notices are signed by Netlify with Ed25519; this Worker holds only the
// public key (PUBLIC_KEY).

const enc = new TextEncoder();

const fromBase64url = text => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), c => c.charCodeAt(0));
};

let keyPromise = null;
function publicKey(env) {
  keyPromise ??= crypto.subtle.importKey('raw', fromBase64url(env.PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
  return keyPromise;
}

// A signed token is "<base64url JSON>.<base64url signature>" of kind `kind`.
async function verify(token, kind, env) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('Ed25519', await publicKey(env), fromBase64url(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body)));
    if (payload.k !== kind || !(payload.exp > Date.now()) || typeof payload.r !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/connect') {
      const [client, server] = Object.values(new WebSocketPair());
      // Hibernatable: an idle connection costs nothing.
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (pathname === '/notify') {
      const message = await request.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(message);
        } catch {
          // A socket that just closed; the device reconnects on its own.
        }
      }
      return new Response('ok');
    }
    return new Response('Not found', { status: 404 });
  }

  webSocketMessage() {
    // Devices only send pings, which are answered automatically.
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'closed');
    } catch {
      // Already closed.
    }
  }
}

// ---- File pieces in R2 (the FILES bucket) ----
// The page uploads and downloads end-to-end encrypted 4 MB pieces here
// directly, so they never pass through (or get metered by) Netlify. Every
// call carries a pass Netlify signed for one file (or one sheet's slot):
//   PUT  /files/up?t=&i=      store piece i (size checked against the pass)
//   GET  /files/get?t=&i=     piece i
//   POST /files/check         (body: pass) the size of each piece, or null
//   POST /files/delete        (body: pass) delete the file's pieces
//   POST /files/purge         (body: pass) delete up to 1000 objects under a prefix → { more }
// The pass is the permission, so any origin may call (no cookies are used).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};
const reply = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
  status,
  headers: { ...CORS, 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers }
});

async function files(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env.FILES) return reply('File storage isn’t set up', 503);
  const op = url.pathname.slice('/files/'.length);
  const methods = { up: 'PUT', get: 'GET', check: 'POST', delete: 'POST', purge: 'POST' };
  if (methods[op] !== request.method) return reply('Not found', 404);
  const token = request.method === 'POST' ? await request.text() : url.searchParams.get('t');
  const pass = await verify(token, 'file', env);
  if (!pass || pass.op !== op || !pass.r.startsWith('files/') || pass.r.includes('..')) return reply('Bad pass', 401);
  const n = Number(pass.n);
  const piece = () => {
    const i = Number(url.searchParams.get('i'));
    return Number.isInteger(i) && i >= 0 && i < n ? `${pass.r}/${i}` : null;
  };

  if (op === 'up') {
    const key = piece();
    const size = Number(request.headers.get('Content-Length'));
    if (!key) return reply('Bad piece', 400);
    if (!(size > 0 && size <= pass.max)) return reply('Wrong size', 413);
    // A stored piece is never replaced (R2 writes are all or nothing): sending
    // it again after a dropped connection is fine, overwriting isn't.
    const existing = await env.FILES.head(key);
    if (existing) return existing.size === size ? reply({ ok: true, kept: true }) : reply('Already stored', 409);
    await env.FILES.put(key, request.body);
    return reply({ ok: true });
  }
  if (op === 'get') {
    const key = piece();
    const object = key && (await env.FILES.get(key));
    if (!object) return reply('Not found', 404);
    return new Response(object.body, {
      headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.size), 'Cache-Control': 'private, max-age=31536000, immutable' }
    });
  }
  if (op === 'check') {
    if (!(n > 0 && n <= 1000)) return reply('Bad pass', 400);
    const heads = await Promise.all(Array.from({ length: n }, (_, i) => env.FILES.head(`${pass.r}/${i}`)));
    return reply({ sizes: heads.map(h => (h ? h.size : null)) });
  }
  if (op === 'delete') {
    if (!(n > 0 && n <= 1000)) return reply('Bad pass', 400);
    await env.FILES.delete(Array.from({ length: n }, (_, i) => `${pass.r}/${i}`));
    return reply({ ok: true });
  }
  // purge: a whole prefix (one sheet's slot), a page at a time.
  if (!pass.r.endsWith('/')) return reply('Bad pass', 400);
  const listed = await env.FILES.list({ prefix: pass.r, limit: 1000 });
  if (listed.objects.length) await env.FILES.delete(listed.objects.map(o => o.key));
  return reply({ more: listed.truncated });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = name => env.ROOMS.get(env.ROOMS.idFromName(name));

    if (url.pathname.startsWith('/files/')) return files(request, env, url);

    if (url.pathname === '/connect') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const pass = await verify(url.searchParams.get('ticket'), 'ticket', env);
      if (!pass) return new Response('Bad pass', { status: 401 });
      return room(pass.r).fetch(new Request('https://room/connect', request));
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      const notice = await verify(await request.text(), 'notify', env);
      if (!notice) return new Response('Bad notice', { status: 401 });
      return room(notice.r).fetch('https://room/notify', {
        method: 'POST',
        body: JSON.stringify({ type: 'changed', part: notice.part, rev: notice.rev })
      });
    }

    return new Response('Scratch Pad sync relay', { status: url.pathname === '/' ? 200 : 404 });
  }
};
