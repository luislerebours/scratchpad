// A throwaway service-account key for the fake Google Play API (playmock.mjs):
// playkey.json for the server, playkey.pub.pem for the mock to check its
// tokens. Made locally, never committed, never a real Google key.
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
const here = new URL('.', import.meta.url);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
fs.writeFileSync(new URL('playkey.json', here), JSON.stringify({
  type: 'service_account',
  client_email: 'scrapsheet-play@test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'http://localhost:8972/token'
}));
fs.writeFileSync(new URL('playkey.pub.pem', here), publicKey.export({ type: 'spki', format: 'pem' }));
console.log('made playkey.json and playkey.pub.pem');
