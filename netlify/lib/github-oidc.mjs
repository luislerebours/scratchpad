import { createPublicKey, verify } from 'node:crypto';

// Sign-in for the nightly backup (.github/workflows/backup.yml). The workflow
// asks GitHub for a short-lived signed token (OIDC, audience
// "scrapsheet-backup"); here we check GitHub's signature and that the token
// was made for that workflow, on main, in this repository (pinned by GitHub's
// numeric ids, which survive renames and can't be reused). No password is
// stored anywhere. It only allows reading for the backup (functions/backup.mjs).
// Same design as FinestIQ's nightly copy.

const ISSUER = 'https://token.actions.githubusercontent.com';
export const BACKUP_AUDIENCE = 'scrapsheet-backup';
const REPOSITORY_ID = '1437427080'; // luislerebours/scratchpad
const OWNER_ID = '179073917';
const WORKFLOW = '/.github/workflows/backup.yml@refs/heads/main';

// GitHub's signing keys: fetched again after an hour or when a token names a
// key we haven't seen, but at most once every 5 minutes and once at a time
// (so made-up tokens can't make us hammer GitHub). A failed fetch keeps the
// keys we had.
const KEYS_MAX_AGE = 3600_000;
const REFETCH_GAP = 300_000;
let keys = { at: 0, tried: 0, list: [] };
let loading = null;
let jwksUrl = `${ISSUER}/.well-known/jwks`;

async function githubKey(kid) {
  const now = Date.now();
  const known = keys.list.some(k => k.kid === kid);
  if ((!known || now - keys.at > KEYS_MAX_AGE) && now - keys.tried >= REFETCH_GAP) {
    keys.tried = now;
    loading ??= (async () => {
      const r = await fetch(jwksUrl, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`GitHub signing keys unavailable (HTTP ${r.status})`);
      keys = { at: Date.now(), tried: keys.tried, list: (await r.json()).keys || [] };
    })().finally(() => { loading = null; });
    await loading;
  } else if (loading) await loading;
  return keys.list.find(k => k.kid === kid) || null;
}

// Tests only: where the signing keys come from (a local stand-in for GitHub).
export function useKeysForTests(url) {
  jwksUrl = url;
  keys = { at: 0, tried: 0, list: [] };
  loading = null;
}

const decode = s => JSON.parse(Buffer.from(s, 'base64url').toString());

// The token's claims when it's valid for the backup, else null (never throws).
// Everything that can be checked without GitHub's keys is checked first, so a
// made-up token never makes us fetch them.
export async function verifyBackupToken(token, { now = Date.now() } = {}) {
  try {
    const [h, p, sig] = String(token || '').split('.');
    if (!h || !p || !sig) return null;
    const header = decode(h);
    const claims = decode(p);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !/^[\w-]{1,128}$/.test(header.kid)) return null;
    const t = now / 1000;
    if (claims.iss !== ISSUER || ![].concat(claims.aud).includes(BACKUP_AUDIENCE) || !(claims.exp > t) || claims.nbf > t + 60) return null;
    if (String(claims.repository_id) !== REPOSITORY_ID || String(claims.repository_owner_id) !== OWNER_ID ||
        claims.ref !== 'refs/heads/main' || claims.job_workflow_ref !== `${claims.repository}${WORKFLOW}` ||
        !['schedule', 'workflow_dispatch'].includes(claims.event_name)) return null;
    const jwk = await githubKey(header.kid);
    if (!jwk) return null;
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'))) return null;
    return claims;
  } catch {
    return null;
  }
}
