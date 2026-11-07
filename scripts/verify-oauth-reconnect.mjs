#!/usr/bin/env node
/**
 * Verification for the OAuth reconnect fix (duplicate → update).
 *
 * Bug (live 2026-11-07 ~18:56): the Facebook OAuth flow SUCCEEDED on
 * Facebook's side (Easin Arafat ES granted ONLY Halal Chic) but the
 * app's callback answered ?facebook=error&reason=duplicate and threw
 * the fresh long-lived user token away — because createOAuthChannel
 * errored whenever the channel row already existed instead of
 * refreshing it. A reconnect must UPDATE the row (fresh Page token,
 * fresh user token, fresh expiry, status connected), never 409.
 *
 * This verifier runs a direct driver (scripts/oauth-reconnect-driver.ts
 * via tsx) against a fresh PGlite DB plus a stub Graph server that
 * records the tokens used by the subscribe calls:
 *  1. First messenger connect → ok, 1 messenger row + 1
 *     facebook_comment row, tokens decrypt to v1, status connected.
 *  2. Reconnect SAME page with new page token v2 + new user token v2
 *     → ok (NOT duplicate), SAME row id, tokens decrypt to v2,
 *     companion row refreshed to v2, no second row — even though the
 *     trial workspace is already at its 1-channel limit (the limit
 *     check is skipped on the update path).
 *  3. Reconnect again with a new page token v3 but NO user token →
 *     page token refreshes to v3 while the stored user token stays v2
 *     (COALESCE guard) — flows without a user token must not wipe it.
 *  4. A genuinely NEW page on the same trial workspace → still
 *     rejected with reason 'limit' (the limit check still works).
 *  5. The subscribe stub saw the refreshed tokens (Bearer v2, v3).
 *
 * Run from the repo root:  node scripts/verify-oauth-reconnect.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 * The PGlite data dir is removed afterwards (stale verifier DBs break
 * Vercel deploys past 15000 files).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const API_DIR = path.join(ROOT, 'apps/api');
const DATA_DIR = '.pglite-data-oauth-reconnect';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read one value from apps/api/.env (never printed). */
function envFileValue(name) {
  const envPath = path.join(API_DIR, '.env');
  if (!fs.existsSync(envPath)) return '';
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${name}=`)) return t.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

async function main() {
  // Stub Graph server: records Authorization headers on subscribe calls.
  const subscribeAuths = [];
  const stub = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.includes('/subscribed_apps')) {
      subscribeAuths.push(req.headers.authorization ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubPort = stub.address().port;

  // Static check: the fix lives in createOAuthChannel.
  const src = fs.readFileSync(path.join(API_DIR, 'src/channels/meta-oauth.ts'), 'utf8');
  check('createOAuthChannel updates on reconnect (no early duplicate return)', !src.includes("if (dupe.rows.length > 0) {\n    return { ok: false, reason: 'duplicate'"));
  check('reconnect UPDATE refreshes tokens + expiry + status', src.includes('UPDATE channels') && src.includes("status = 'connected'") && src.includes('COALESCE($2, user_token_encrypted)'));
  check('companion facebook_comment row is upserted on reconnect', src.includes("platform = 'facebook_comment'") && src.includes("SET token_encrypted = $1, user_token_encrypted = COALESCE($2, user_token_encrypted)"));

  const dataDirAbs = path.join(API_DIR, DATA_DIR);
  try {
    const proc = spawn('npx', ['tsx', '../../scripts/oauth-reconnect-driver.ts'], {
      cwd: API_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USE_PGLITE: 'true',
        DATABASE_URL: `pglite://${DATA_DIR}`,
        PGLITE_DATA_DIR: DATA_DIR,
        JWT_SECRET: envFileValue('JWT_SECRET'),
        TOKEN_ENCRYPTION_KEY: envFileValue('TOKEN_ENCRYPTION_KEY'),
        META_GRAPH_BASE_URL: `http://127.0.0.1:${stubPort}/v21.0`,
      },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const exitCode = await new Promise((resolve) => proc.on('close', resolve));
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let summary = null;
    try { summary = JSON.parse(lastLine); } catch { /* fall through */ }
    if (!summary) {
      check('driver produced a JSON summary', false, `exit=${exitCode}, stdout=${stdout.slice(-500)}, stderr=${stderr.slice(-500)}`);
    } else {
      check('driver ok', summary.ok === true, summary.error ?? '');
      check('1. first connect ok, tokens v1, status connected', summary.firstOk === true && summary.firstTokenIsV1 === true && summary.firstUserTokenIsV1 === true && summary.firstStatusConnected === true, JSON.stringify(summary));
      check('1. first connect created 1 messenger + 1 companion row', summary.firstMessengerRows === 1 && summary.firstCommentRows === 1, `messenger=${summary.firstMessengerRows}, comment=${summary.firstCommentRows}`);
      check('1. companion row tokens are v1', summary.firstCompanionTokenIsV1 === true && summary.firstCompanionUserTokenIsV1 === true);
      check('2. reconnect same page → ok (NOT duplicate)', summary.secondOk === true && summary.secondReason === null, `reason=${summary.secondReason}`);
      check('2. reconnect kept the SAME row id, tokens refreshed to v2', summary.secondSameRowId === true && summary.secondTokenIsV2 === true && summary.secondUserTokenIsV2 === true && summary.secondConnectedByIsV2 === true, JSON.stringify(summary));
      check('2. reconnect status connected, expiry refreshed', summary.secondStatusConnected === true && summary.expiresRefreshed === true);
      check('2. reconnect created NO second row', summary.secondMessengerRows === 1 && summary.secondCommentRows === 1, `messenger=${summary.secondMessengerRows}, comment=${summary.secondCommentRows}`);
      check('2. companion row refreshed to v2', summary.secondCompanionTokenIsV2 === true && summary.secondCompanionUserTokenIsV2 === true);
      check('3. reconnect without user token keeps stored user token v2', summary.thirdOk === true && summary.thirdTokenIsV3 === true && summary.thirdUserTokenKeptV2 === true && summary.thirdConnectedByKept === true, JSON.stringify(summary));
      check('3. still exactly 1 messenger row after 3 connects', summary.thirdMessengerRows === 1, `rows=${summary.thirdMessengerRows}`);
      check('4. genuinely new page on full trial workspace still hits limit', summary.fourthLimitStillEnforced === true, `ok=${summary.fourthOk}, reason=${summary.fourthReason}`);
    }
    check('5. subscribe stub saw the refreshed page tokens', subscribeAuths.includes('Bearer tok-page-v2') && subscribeAuths.includes('Bearer tok-page-v3'), `auths=${JSON.stringify(subscribeAuths.map((a) => a.replace('Bearer tok-page-', 'tok-page-')))}`);
  } finally {
    stub.close();
    // Remove the scratch PGlite dir: stale verifier DBs break deploys.
    try { fs.rmSync(dataDirAbs, { recursive: true, force: true }); } catch { /* ignore */ }
    await sleep(500);
  }
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
      console.log('FAILED:');
      for (const f of failed) console.log(` - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('Verifier crashed:', err);
    process.exit(1);
  });
