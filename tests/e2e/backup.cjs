// The nightly backup (tools/backup/, netlify/functions/backup.mjs): run whole,
// with local folders standing in for Google Drive and R2, then restored into a
// fresh Blobs server and compared. Needs reset.sh running and rclone on PATH.
//   node backup.cjs
const { execFileSync, spawnSync, execFile } = require('node:child_process');
// The fresh Blobs server runs in this process, so the restore must run without blocking it.
const run = (cmd, args, opts) => new Promise(res => execFile(cmd, args, { encoding: 'utf8', ...opts }, (err, stdout, stderr) => res({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'out', 'backup');
const SITE = 'http://localhost:8970';
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) fails++; };

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://token.actions.githubusercontent.com', aud: 'scrapsheet-backup', exp: now + 300, nbf: now - 5,
    repository: 'luislerebours/scratchpad', repository_id: '1437427080', repository_owner_id: '179073917',
    ref: 'refs/heads/main', event_name: 'schedule',
    job_workflow_ref: 'luislerebours/scratchpad/.github/workflows/backup.yml@refs/heads/main', ...over
  };
  const head = b64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }) + '.' + b64(claims);
  const key = fs.readFileSync(path.join(__dirname, 'out', 'oidc-test-key.pem'));
  return head + '.' + crypto.sign('RSA-SHA256', Buffer.from(head), key).toString('base64url');
}

const sh = p => p.replace(/\\/g, '/');
function nightly(day, extra = {}) {
  const env = {
    ...process.env,
    RCLONE_CONFIG: sh(path.join(OUT, 'empty.conf')),
    RCLONE_CONFIG_DRIVE_TYPE: 'alias', RCLONE_CONFIG_DRIVE_REMOTE: sh(path.join(OUT, 'drive')),
    RCLONE_CONFIG_FAKER2_TYPE: 'alias', RCLONE_CONFIG_FAKER2_REMOTE: sh(path.join(OUT, 'r2')),
    R2_SRC: 'faker2:', BACKUP_PASSPHRASE: 'correct horse battery staple test', SITE, TOKEN: token(), DAY: day, ...extra
  };
  return spawnSync('bash', [sh(path.join(REPO, 'tools/backup/nightly.sh'))], { env, encoding: 'utf8' });
}
const vaultEnv = () => ({
  ...process.env, RCLONE_CONFIG: sh(path.join(OUT, 'empty.conf')),
  RCLONE_CONFIG_VAULT_TYPE: 'crypt', RCLONE_CONFIG_VAULT_REMOTE: sh(path.join(OUT, 'drive', 'ScrapSheet backups', 'locked')),
  RCLONE_CONFIG_VAULT_FILENAME_ENCRYPTION: 'standard', RCLONE_CONFIG_VAULT_DIRECTORY_NAME_ENCRYPTION: 'true',
  RCLONE_CONFIG_VAULT_PASSWORD: execFileSync('rclone', ['obscure', 'correct horse battery staple test'], { encoding: 'utf8' }).trim()
});
const vault = (...args) => execFileSync('rclone', args, { env: vaultEnv(), encoding: 'utf8' });
const drive = (...p) => path.join(OUT, 'drive', 'ScrapSheet backups', ...p);
const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];

(async () => {
  // Same stand-in as serve.mjs: the local Blobs server lists stores only at /<site>.
  const realFetch = globalThis.fetch;
  // A kept-alive connection the local server already closed (the test waits on rclone between calls) fails once: retry.
  const fixUrl = input => typeof input === 'string' || input instanceof URL ? String(input).replace(/^(http:\/\/localhost:\d+)\/api\/v1\/blobs\/(site)(\?|$)/, '$1/$2$3') : input;
  globalThis.fetch = (input, init) => realFetch(fixUrl(input), init).catch(e => e.cause?.code === 'ECONNRESET' ? realFetch(fixUrl(input), init) : Promise.reject(e));
  const { getStore, listStores } = await import('@netlify/blobs');
  const ctx = port => Buffer.from(JSON.stringify({ apiURL: `http://localhost:${port}`, siteID: 'site', token: 'tok' })).toString('base64');
  process.env.NETLIFY_BLOBS_CONTEXT = ctx(8971);
  const { encodeName, decodeName } = await import('file://' + sh(path.join(REPO, 'tools/backup/names.mjs')));

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'r2', 'files', 'abc', '1', 'f1'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'empty.conf'), '');

  // Names: round trip, and no two names differ only by case.
  const names = ['meta/sheets', 'Meta/Sheets', 'files/Ab/0', 'é ü/🙂', '.', '..', 'a~b^c%2F'];
  check(names.every(n => decodeName(encodeName(n)) === n), 'file names decode back to the same key');
  check(new Set(names.map(n => encodeName(n).toLowerCase())).size === names.length, 'no two names differ only by case');

  // Who may call it.
  const call = (t, q = 'op=index') => fetch(`${SITE}/.netlify/functions/backup?${q}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  check((await call(null)).status === 401, 'no token: refused');
  check((await call(token({ repository_id: '1' }))).status === 401, 'token from another repository: refused');
  check((await call(token({ ref: 'refs/heads/evil' }))).status === 401, 'token from another branch: refused');
  check((await call(token({ event_name: 'pull_request' }))).status === 401, 'token from a pull request run: refused');
  check((await call(token({ exp: 1 }))).status === 401, 'expired token: refused');
  check((await call((t => t.slice(0, -20) + (t.at(-20) === 'A' ? 'B' : 'A') + t.slice(-19))(token()))).status === 401, 'token with a broken signature: refused');
  check((await call(token())).status === 200, 'the workflow\'s token: allowed');

  // Some data, beside whatever earlier tests left.
  const s1 = getStore({ name: 'bk-test-Acc', consistency: 'strong' });
  const s2 = getStore({ name: 'bk-test-files-1', consistency: 'strong' });
  const big = crypto.randomBytes(3 * 1024 * 1024 + 17);
  await s1.set('meta/sheets', JSON.stringify({ a: 1 }));
  await s1.set('Caps/Key', 'capitals'); // (no twin differing only by case: the local Blobs server on Windows can't hold both)
  await s1.set('text/1', 'first version');
  await s1.set('gone/soon', 'delete me');
  await s2.set('file1/0', big.buffer.slice(big.byteOffset, big.byteOffset + big.length));
  fs.writeFileSync(path.join(OUT, 'r2', 'files', 'abc', '1', 'f1', '0'), crypto.randomBytes(1000));
  fs.writeFileSync(path.join(OUT, 'r2', 'files', 'abc', '1', 'f1', '1'), crypto.randomBytes(1000));

  // Night 1.
  let r = nightly('2026-11-01');
  console.log(r.stdout.trim()); if (r.status !== 0) console.log(r.stderr);
  check(r.status === 0, 'night 1 runs');
  check(fs.existsSync(drive('code', '2026-11-01', 'scrapsheet-code-2026-11-01.zip')), 'code zip in Drive');
  check(fs.existsSync(drive('code', '2026-11-01', 'scrapsheet-code-2026-11-01.bundle')), 'code bundle in Drive');
  check(fs.readFileSync(drive('READ ME FIRST - ScrapSheet recovery guide.md'), 'utf8').includes('ScrapSheet recovery guide'), 'recovery guide on top');
  check(/Last backup: 2026-11-01/.test(fs.readFileSync(drive('last-backup.txt'), 'utf8')), 'last-backup.txt written');
  const lockedFiles = walk(drive('locked'));
  const lockedText = lockedFiles.join('\n');
  check(lockedFiles.length > 5 && !/meta|sheets|bk-test|files|manifest/i.test(lockedText.slice(drive('locked').length)), 'locked part: names are encrypted');
  check(!lockedFiles.some(f => fs.readFileSync(f).includes('first version')), 'locked part: contents are encrypted');
  const listed = vault('lsf', '-R', '--files-only', 'vault:').split('\n');
  check(listed.includes(`blobs/${encodeName('bk-test-Acc')}/${encodeName('Caps/Key')}`), 'vault opens with the passphrase and holds the blobs');
  check(listed.includes('r2/files/abc/1/f1/0') && listed.includes('r2/files/abc/1/f1/1'), 'R2 pieces copied');
  const bigCopy = execFileSync('rclone', ['cat', `vault:blobs/${encodeName('bk-test-files-1')}/${encodeName('file1/0')}`], { env: vaultEnv(), maxBuffer: 64e6 });
  check(Buffer.compare(bigCopy, big) === 0, 'the 3 MB blob is byte for byte the same');

  // Night 2: one changed, one new, one deleted; an R2 piece deleted.
  await s1.set('text/1', 'second version');
  await s1.set('text/2', 'new one');
  await s1.delete('gone/soon');
  fs.rmSync(path.join(OUT, 'r2', 'files', 'abc', '1', 'f1', '1'));
  r = nightly('2026-11-02');
  if (r.status !== 0) console.log(r.stdout, r.stderr);
  check(r.status === 0, 'night 2 runs');
  check(/2 new or changed/.test(r.stdout) && /1 gone since last night/.test(r.stdout), 'night 2 fetches only what changed (' + (r.stdout.match(/Blobs:.*/) || [''])[0] + ')');
  const b = (store, key) => `vault:blobs/${encodeName(store)}/${encodeName(key)}`;
  const o = (day, store, key) => `vault:old/${day}/blobs/${encodeName(store)}/${encodeName(key)}`;
  check(vault('cat', b('bk-test-Acc', 'text/1')) === 'second version', 'changed blob: new version in the mirror');
  check(vault('cat', o('2026-11-02', 'bk-test-Acc', 'text/1')) === 'first version', 'changed blob: earlier version kept in old/<day>');
  check(vault('cat', o('2026-11-02', 'bk-test-Acc', 'gone/soon')) === 'delete me', 'deleted blob: moved to old/<day>');
  check(!vault('lsf', '-R', 'vault:blobs').includes(encodeName('gone/soon')), 'deleted blob: out of the mirror');
  const listed2 = vault('lsf', '-R', '--files-only', 'vault:').split('\n');
  check(!listed2.includes('r2/files/abc/1/f1/1') && listed2.includes('old/2026-11-02/r2/files/abc/1/f1/1'), 'deleted R2 piece: moved to old/<day>');

  // A site that lost most of its data must not empty the backup.
  for (let i = 0; i < 80; i++) await s1.set(`many/${i}`, 'x');
  check(nightly('2026-11-03').status === 0, 'night 3 runs (80 more)');
  for (let i = 0; i < 80; i++) await s1.delete(`many/${i}`);
  r = nightly('2026-11-04');
  check(r.status !== 0 && /are gone from the site/.test(r.stderr + r.stdout), 'big delete: stopped, backup kept');
  check(vault('lsf', `vault:blobs/${encodeName('bk-test-Acc')}`).includes(encodeName('many/5')), 'big delete: blobs still in the mirror');
  r = nightly('2026-11-04', { ALLOW_BIG_DELETE: '1' });
  check(r.status === 0, 'big delete: goes ahead when allowed');

  // Old day folders go after 45 days.
  r = nightly('2026-12-20');
  check(r.status === 0, 'night 50 days later runs');
  check(!fs.existsSync(drive('code', '2026-11-01')) && fs.existsSync(drive('code', '2026-12-20')), 'code folders older than 45 days removed');
  const after = vault('lsf', '-R', 'vault:');
  check(!after.includes('old/2026-11-02/') && !after.includes('manifests/2026-11-01.json'), 'old/ and manifests older than 45 days removed');
  check(after.includes(`blobs/${encodeName('bk-test-Acc')}/${encodeName('text/1')}`), 'the mirror itself stays');

  // Restore into an empty Blobs server and compare everything.
  const restoreDir = path.join(OUT, 'restore');
  vault('copy', 'vault:blobs', sh(restoreDir));
  const { BlobsServer } = await import('file://' + sh(path.join(REPO, 'node_modules/@netlify/blobs/dist/server.js')));
  const fresh = new BlobsServer({ directory: path.join(OUT, 'fresh-blobs'), port: 8975, token: 'tok' });
  await fresh.start();
  r = await run('node', [path.join(REPO, 'tools/backup/restore-blobs.mjs'), restoreDir], { env: { ...process.env, NETLIFY_BLOBS_CONTEXT: ctx(8975) }, cwd: REPO });
  console.log(r.stdout.trim(), r.stderr.trim());
  check(r.status === 0, 'restore runs');
  const dump = async port => {
    process.env.NETLIFY_BLOBS_CONTEXT = ctx(port);
    const out = {};
    const { stores } = await listStores();
    for (const name of stores) {
      const st = getStore({ name, consistency: 'strong' });
      for (const { key } of (await st.list()).blobs) out[`${name}|${key}`] = crypto.createHash('sha256').update(Buffer.from(await st.get(key, { type: 'arrayBuffer' }))).digest('hex');
    }
    return out;
  };
  const src = await dump(8971);
  const dst = await dump(8975);
  const diff = Object.keys({ ...src, ...dst }).filter(k => src[k] !== dst[k]);
  check(Object.keys(src).length > 5 && diff.length === 0, `restored site matches the original (${Object.keys(src).length} blobs, ${diff.length} differ)`);
  r = await run('node', [path.join(REPO, 'tools/backup/restore-blobs.mjs'), restoreDir], { env: { ...process.env, NETLIFY_BLOBS_CONTEXT: ctx(8975) }, cwd: REPO });
  check(/0 written/.test(r.stdout), 'a second restore leaves what\'s there alone');
  await fresh.stop();

  // The bundle clones.
  const clone = path.join(OUT, 'clone');
  r = spawnSync('git', ['clone', '-q', drive('code', '2026-12-20', 'scrapsheet-code-2026-12-20.bundle'), clone], { encoding: 'utf8' });
  check(r.status === 0 && fs.existsSync(path.join(clone, 'CLAUDE.md')), 'the code bundle clones');

  // Tidy the test stores so other tests' counts aren't affected.
  process.env.NETLIFY_BLOBS_CONTEXT = ctx(8971);
  for (const st of [s1, s2]) for (const { key } of (await st.list()).blobs) await st.delete(key);

  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
