import { DurableObject } from 'cloudflare:workers';

// Real-time relay for Scratch Pad. Each account has a room; its open devices
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = name => env.ROOMS.get(env.ROOMS.idFromName(name));

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
