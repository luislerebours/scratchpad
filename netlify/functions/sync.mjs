import { json, requireUser, syncPublicKey, syncTicket } from '../lib/auth.mjs';

// Passes for the real-time relay. ?action=key gives the public key the relay
// checks signatures with (public by design); otherwise a signed-in device
// gets a short-lived pass to connect to its account's room.
export default async req => {
  const url = new URL(req.url);
  if (url.searchParams.get('action') === 'key') {
    return json({ publicKey: await syncPublicKey() });
  }
  const auth = await requireUser(req);
  if (auth.error) return auth.error;
  return json((await syncTicket(auth.ns)) || { url: null });
};
