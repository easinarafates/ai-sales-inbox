/**
 * verify-user-token-photo.ts — proves the user-token profile fallbacks
 * in apps/api/src/channels/meta-profile.ts against a stub Graph with a
 * fresh throwaway PGlite DB. Run from the repo root:
 *
 *   npx tsx scripts/verify-user-token-photo.ts
 *
 * (The .mjs customer-photo verifier spawns this and folds its
 * PASS/FAIL lines into its own count.)
 *
 * Stub Graph behaviour (Bearer distinguishes the credential):
 * - Page token ('stub-page-token'): the direct PSID read 400s (#100/33)
 *   and the conversations edge returns a NAME but strips the picture —
 *   exactly what live Meta does for a phone-registered sender.
 * - User token ('stub-user-token'): the direct read WORKS for
 *   psid-usertoken (name + photo); /me/picture returns the owner's
 *   photo for the marked-owner sender.
 *
 * Checks:
 * 1. User-token direct read fills name + photo (source 'meta') when the
 *    Page token gives nothing.
 * 2. Owner route: sender == owner_psid gets the photo from /me/picture
 *    even though every PSID route fails for him.
 * 3. No user token: name fills from conversations, photo stays NULL
 *    (unchanged behaviour).
 * 4. A non-owner sender never gets the /me/picture photo (owner gate).
 * 5. A silhouette /picture is ignored (no fake photo stored).
 * 6. A stored name is never overwritten by the user-token fetch.
 *
 * Prints "PASS <name>" / "FAIL <name>" lines + "N/M checks passed".
 * Exits 0 only when every check passes. Never prints a token.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const STUB_PORT = 4021;
const PAGE_TOKEN = 'stub-page-token';
const USER_TOKEN = 'stub-user-token';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function parseEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}

function graph400(res: http.ServerResponse): void {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: "Unsupported get request. Object with ID 'x' does not exist, cannot be loaded due to missing permissions, or does not support this operation.", type: 'GraphMethodException', code: 100, error_subcode: 33 } }));
}

function startStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const seg = url.pathname.split('/').filter(Boolean); // ['v21.0', ...]
    const senderId = decodeURIComponent(seg[1] ?? '');
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // /me/picture — the owner route (user token only).
    if (seg[1] === 'me' && seg[2] === 'picture') {
      if (bearer !== USER_TOKEN) return graph400(res);
      return send(200, { data: { height: 200, width: 200, is_silhouette: false, url: 'https://example.com/owner.jpg' } });
    }
    // /{psid}/picture — silhouette for one sender (must be ignored),
    // 400 for everyone else (keeps the test strict).
    if (seg[2] === 'picture') {
      if (bearer === USER_TOKEN && senderId === 'psid-silhouette') {
        return send(200, { data: { height: 50, width: 50, is_silhouette: true, url: 'https://example.com/silhouette.jpg' } });
      }
      return graph400(res);
    }
    // /{page-id}/conversations?user_id=... — name, picture stripped.
    if (seg[2] === 'conversations') {
      const senderId = url.searchParams.get('user_id') ?? '';
      const names: Record<string, string> = { 'psid-usertoken': 'User Token', 'psid-owner': 'Owner Person', 'psid-nouser': 'No User', 'psid-silhouette': 'Silhouette Owner' };
      return send(200, { data: [{ id: 'thread-1', participants: [{ id: senderId, name: names[senderId] ?? 'Somebody' }] }] });
    }
    // Direct read /{senderId}
    if (bearer === USER_TOKEN && senderId === 'psid-usertoken') {
      return send(200, { first_name: 'User', last_name: 'Token', profile_pic: { data: { url: 'https://example.com/user-token.jpg' } } });
    }
    return graph400(res);
  });
  return new Promise((resolve) => server.listen(STUB_PORT, () => resolve(server)));
}

async function main(): Promise<number> {
  const apiEnv = parseEnvFile(path.join(ROOT, 'apps/api/.env'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-usertoken-'));
  // Env BEFORE importing the pool/config (they read it at import time).
  process.env.DATABASE_URL = `pglite://${dataDir}`;
  process.env.META_GRAPH_BASE_URL = `http://localhost:${STUB_PORT}/v21.0`;
  process.env.JWT_SECRET = apiEnv.JWT_SECRET ?? 'verify-test-secret';
  process.env.TOKEN_ENCRYPTION_KEY = apiEnv.TOKEN_ENCRYPTION_KEY ?? '';
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    console.log('FAIL  test setup — TOKEN_ENCRYPTION_KEY missing from apps/api/.env');
    return 1;
  }

  const stub = await startStub();
  try {
    const { pool } = await import(path.join(ROOT, 'apps/api/src/db/pool'));
    const { enrichCustomerProfileIfNeeded } = await import(path.join(ROOT, 'apps/api/src/channels/meta-profile'));

    const ws = await pool.query<{ id: string }>(
      "INSERT INTO workspaces (name, owner_psid) VALUES ('Probe Shop', 'psid-owner') RETURNING id",
    );
    const workspaceId = ws.rows[0].id;

    async function makeCustomer(): Promise<string> {
      const r = await pool.query<{ id: string }>(
        'INSERT INTO customers (workspace_id, channel_identities) VALUES ($1, $2::jsonb) RETURNING id',
        [workspaceId, '[]'],
      );
      return r.rows[0].id;
    }
    async function readCustomer(id: string): Promise<{ name: string | null; picture_url: string | null; picture_source: string | null }> {
      const r = await pool.query<{ name: string | null; picture_url: string | null; picture_source: string | null }>(
        'SELECT name, picture_url, picture_source FROM customers WHERE id = $1',
        [id],
      );
      return r.rows[0];
    }

    // 1. User-token direct read fills name + photo when the Page token gives nothing.
    const c1 = await makeCustomer();
    await enrichCustomerProfileIfNeeded({
      workspaceId, platform: 'messenger', senderId: 'psid-usertoken', customerId: c1,
      customerName: null, customerPictureUrl: null, customerPictureSource: null,
      pageToken: PAGE_TOKEN, userToken: USER_TOKEN, ownerPsid: null, pageId: 'stub-page-id',
    });
    const r1 = await readCustomer(c1);
    check('user-token direct read fills the name', r1.name === 'User Token', `name=${r1.name}`);
    check('user-token direct read fills the photo', r1.picture_url === 'https://example.com/user-token.jpg', `pic=${r1.picture_url}`);
    check('user-token photo is marked meta', r1.picture_source === 'meta', `source=${r1.picture_source}`);

    // 2. Owner route: every PSID route fails, /me/picture gives the photo.
    const c2 = await makeCustomer();
    await enrichCustomerProfileIfNeeded({
      workspaceId, platform: 'messenger', senderId: 'psid-owner', customerId: c2,
      customerName: null, customerPictureUrl: null, customerPictureSource: null,
      pageToken: PAGE_TOKEN, userToken: USER_TOKEN, ownerPsid: 'psid-owner', pageId: 'stub-page-id',
    });
    const r2 = await readCustomer(c2);
    check('owner gets a name from conversations', r2.name === 'Owner Person', `name=${r2.name}`);
    check('owner gets the photo from /me/picture', r2.picture_url === 'https://example.com/owner.jpg', `pic=${r2.picture_url}`);
    check('owner photo is marked meta', r2.picture_source === 'meta', `source=${r2.picture_source}`);

    // 3. No user token: name fills, photo stays NULL (unchanged behaviour).
    const c3 = await makeCustomer();
    await enrichCustomerProfileIfNeeded({
      workspaceId, platform: 'messenger', senderId: 'psid-nouser', customerId: c3,
      customerName: null, customerPictureUrl: null, customerPictureSource: null,
      pageToken: PAGE_TOKEN, userToken: null, ownerPsid: null, pageId: 'stub-page-id',
    });
    const r3 = await readCustomer(c3);
    check('no user token: name still fills', r3.name === 'No User', `name=${r3.name}`);
    check('no user token: photo stays NULL', r3.picture_url === null, `pic=${r3.picture_url}`);

    // 4. Non-owner sender never gets the /me/picture photo: every PSID
    //    route fails for psid-owner, and the owner gate is closed.
    const c4 = await makeCustomer();
    await enrichCustomerProfileIfNeeded({
      workspaceId, platform: 'messenger', senderId: 'psid-owner', customerId: c4,
      customerName: null, customerPictureUrl: null, customerPictureSource: null,
      pageToken: PAGE_TOKEN, userToken: USER_TOKEN, ownerPsid: 'someone-else', pageId: 'stub-page-id',
    });
    const r4 = await readCustomer(c4);
    check('non-owner never gets the /me/picture photo', r4.name === 'Owner Person' && r4.picture_url === null, `name=${r4.name} pic=${r4.picture_url}`);

    // 5. A silhouette /picture is ignored (placeholder, not a photo).
    const c5 = await makeCustomer();
    await enrichCustomerProfileIfNeeded({
      workspaceId, platform: 'messenger', senderId: 'psid-silhouette', customerId: c5,
      customerName: null, customerPictureUrl: null, customerPictureSource: null,
      pageToken: PAGE_TOKEN, userToken: USER_TOKEN, ownerPsid: null, pageId: 'stub-page-id',
    });
    const r5 = await readCustomer(c5);
    check('silhouette picture is ignored', r5.picture_url === null, `pic=${r5.picture_url}`);

    // 6. A stored name is never overwritten by the user-token fetch.
    const c6 = await makeCustomer();
    await enrichCustomerProfileIfNeeded({
      workspaceId, platform: 'messenger', senderId: 'psid-usertoken', customerId: c6,
      customerName: 'Already Named', customerPictureUrl: null, customerPictureSource: null,
      pageToken: PAGE_TOKEN, userToken: USER_TOKEN, ownerPsid: 'psid-owner', pageId: 'stub-page-id',
    });
    const r6 = await readCustomer(c6);
    check('stored name is kept, photo still fills', r6.name === 'Already Named' && r6.picture_url === 'https://example.com/user-token.jpg', `name=${r6.name} pic=${r6.picture_url}`);

    console.log(`\n${passed}/${passed + failed} checks passed`);
    return failed === 0 ? 0 : 1;
  } finally {
    stub.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('probe crashed:', (err as Error).message); process.exit(1); });
