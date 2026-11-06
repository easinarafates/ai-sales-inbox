#!/usr/bin/env node
/**
 * Harness for the TikTok DM router (module-level test, no integration needed).
 *
 * Mounts the compiled dist/webhooks/tiktok-dm.js router on a throwaway
 * Express app backed by a FRESH throwaway PGlite dir (its own DATABASE_URL),
 * so it never touches the real API's data folder (PGlite allows only one
 * process per folder). Run by scripts/verify-tiktok-embeddings.mjs:
 *   node scripts/harness-tiktok-dm.mjs --scenario unapproved|approved
 * Env: DATABASE_URL, SCHEMA_PATH, JWT_SECRET, TOKEN_ENCRYPTION_KEY,
 * TIKTOK_DM_VERIFY_TOKEN, TIKTOK_DM_APPROVED, AI_PROVIDER, GEMINI_API_KEY,
 * GROQ_API_KEY. Prints ONE JSON block between __HARNESS_JSON_START__ and
 * __HARNESS_JSON_END__ (other stdout noise from imported modules is ignored
 * by the caller) and exits 0/1.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'apps', 'api');
const scenario = process.argv.includes('--scenario')
  ? process.argv[process.argv.indexOf('--scenario') + 1]
  : 'unapproved';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') });
}

async function main() {
  // Env fallbacks BEFORE importing any dist module (config reads env at import).
  process.env.JWT_SECRET ??= 'harness-jwt-secret';
  process.env.TOKEN_ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.SCHEMA_PATH ??= path.join(ROOT, 'schema.sql');
  if (!process.env.DATABASE_URL) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiktok-dm-harness-'));
    process.env.DATABASE_URL = `pglite://${dir}`;
  }

  const require = createRequire(path.join(API_DIR, 'package.json'));
  const express = require('express');
  const dist = (p) => pathToFileURL(path.join(API_DIR, 'dist', p)).href;
  const dm = await import(dist('webhooks/tiktok-dm.js'));
  const { pool } = await import(dist('db/pool.js'));

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/webhooks', dm.tiktokDmRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, p, body, query = '') {
    const res = await fetch(`${base}${p}${query}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, text };
  }
  async function count(sql) {
    const { rows } = await pool.query(sql);
    return Number(rows[0]?.n ?? rows[0]?.count ?? 0);
  }

  try {
    check('router exports tiktokDmRouter', typeof dm.tiktokDmRouter === 'function' || typeof dm.tiktokDmRouter === 'object');
    check('isTikTokDMApproved() matches scenario', dm.isTikTokDMApproved() === (scenario === 'approved'), `approved=${dm.isTikTokDMApproved()}`);

    // Pure parser check (no DB): Meta-style entry payload parses correctly.
    const parsed = dm.parseTikTokDMs({
      entry: [{ messaging: [{ sender: { id: 'tt-user-9' }, recipient: { id: 'tt-acct-1' }, message: { mid: 'dm-parse-1', text: 'হ্যালো' } }] }],
    });
    check('parseTikTokDMs handles Meta-style entry payload', parsed.length === 1 && parsed[0].messageId === 'dm-parse-1' && parsed[0].text === 'হ্যালো' && parsed[0].senderId === 'tt-user-9', JSON.stringify(parsed[0] ?? null));

    // Handshake (token from TIKTOK_DM_VERIFY_TOKEN env, set by the caller).
    const okShake = await call('GET', '/api/webhooks/tiktok-dm', null, '?hub.mode=subscribe&hub.verify_token=harness-token&hub.challenge=abc123');
    check('GET handshake with correct token returns challenge', okShake.status === 200 && okShake.text === 'abc123', `status=${okShake.status}`);
    const badShake = await call('GET', '/api/webhooks/tiktok-dm', null, '?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc123');
    check('GET handshake with wrong token is 403', badShake.status === 403, `status=${badShake.status}`);

    const flatDm = { messageId: 'dm-1', senderId: 'tt-user-1', senderName: 'Nusrat', text: 'শাড়ির দাম কত?', recipientId: 'tt-acct-1' };

    if (scenario === 'unapproved') {
      const inBefore = await count('SELECT count(*) AS n FROM messages');
      const evBefore = await count('SELECT count(*) AS n FROM webhook_events');
      const r = await call('POST', '/api/webhooks/tiktok-dm', flatDm);
      check('POST DM with TIKTOK_DM_APPROVED unset is 403', r.status === 403 && r.data?.approvalRequired === true, `status=${r.status}, ${JSON.stringify(r.data)}`);
      const inAfter = await count('SELECT count(*) AS n FROM messages');
      const evAfter = await count('SELECT count(*) AS n FROM webhook_events');
      check('rejected DM stores nothing (no message, no webhook event)', inAfter === inBefore && evAfter === evBefore, `messages ${inBefore}->${inAfter}, events ${evBefore}->${evAfter}`);
      const sent = await dm.sendTikTokDM('ws-1', 'tt-user-1', 'test');
      check('sendTikTokDM without approval is stub-only (sent=false)', sent.sent === false && sent.stub === true && sent.reason === 'not_approved', JSON.stringify(sent));
    } else {
      // Fixtures: workspace + connected tiktok_dm channel.
      const { rows: wsRows } = await pool.query(
        "INSERT INTO workspaces (name, balance_paisa) VALUES ('Harness Shop', 5000) RETURNING id",
      );
      const workspaceId = wsRows[0].id;
      await pool.query(
        "INSERT INTO channels (workspace_id, platform, external_id, display_name, status) VALUES ($1, 'tiktok_dm', 'tt-acct-1', 'Harness TikTok', 'connected')",
        [workspaceId],
      );
      const r1 = await call('POST', '/api/webhooks/tiktok-dm', flatDm);
      check('POST flat DM is accepted (200, accepted=1)', r1.status === 200 && r1.data?.accepted === 1, `status=${r1.status}, ${JSON.stringify(r1.data)}`);
      const inCount = await count("SELECT count(*) AS n FROM messages WHERE direction = 'in'");
      check('DM stored as one inbound message with the right text', inCount === 1, `inbound=${inCount}`);
      const { rows: msgRows } = await pool.query(
        "SELECT body, platform_message_id FROM messages WHERE direction = 'in' LIMIT 1",
      );
      check('stored message body + platform id match the DM', msgRows[0]?.body === 'শাড়ির দাম কত?' && msgRows[0]?.platform_message_id === 'dm-1', JSON.stringify(msgRows[0] ?? null));
      const { rows: convRows } = await pool.query(
        "SELECT c.id, ch.platform FROM conversations c LEFT JOIN channels ch ON ch.id = c.channel_id WHERE c.workspace_id = $1",
        [workspaceId],
      );
      check('conversation routed via the tiktok_dm channel', convRows.length === 1 && convRows[0]?.platform === 'tiktok_dm', JSON.stringify(convRows[0] ?? null));
      const { rows: custRows } = await pool.query(
        'SELECT channel_identities FROM customers WHERE workspace_id = $1',
        [workspaceId],
      );
      const identities = JSON.stringify(custRows[0]?.channel_identities ?? '');
      check("customer identity is platform 'tiktok_dm'", identities.includes('tiktok_dm') && identities.includes('tt-user-1'), identities);
      const evCount = await count("SELECT count(*) AS n FROM webhook_events WHERE platform = 'tiktok_dm'");
      check('webhook event recorded (platform tiktok_dm)', evCount === 1, `events=${evCount}`);

      // Duplicate: same messageId again must not store or answer twice.
      const rDup = await call('POST', '/api/webhooks/tiktok-dm', flatDm);
      const inAfterDup = await count("SELECT count(*) AS n FROM messages WHERE direction = 'in'");
      check('duplicate DM ignored (accepted=0, still 1 inbound message)', rDup.status === 200 && rDup.data?.accepted === 0 && inAfterDup === 1, `accepted=${rDup.data?.accepted}, inbound=${inAfterDup}`);

      // Meta-style entry payload.
      const r2 = await call('POST', '/api/webhooks/tiktok-dm', {
        entry: [{ messaging: [{ sender: { id: 'tt-user-2' }, recipient: { id: 'tt-acct-1' }, message: { mid: 'dm-2', text: 'পাঞ্জাবি আছে?' } }] }],
      });
      const inAfter2 = await count("SELECT count(*) AS n FROM messages WHERE direction = 'in'");
      check('Meta-style entry DM accepted', r2.status === 200 && r2.data?.accepted === 1 && inAfter2 === 2, `accepted=${r2.data?.accepted}, inbound=${inAfter2}`);

      // No text → 400.
      const rBad = await call('POST', '/api/webhooks/tiktok-dm', { messageId: 'dm-3', senderId: 'tt-user-3' });
      check('DM without text is 400', rBad.status === 400, `status=${rBad.status}`);

      // Unknown account with no channel at all → accepted 0, still 200.
      // Delete in FK order: messages → conversations → channels.
      await pool.query('DELETE FROM messages WHERE workspace_id = $1', [workspaceId]);
      await pool.query('DELETE FROM conversations WHERE workspace_id = $1', [workspaceId]);
      await pool.query('DELETE FROM channels WHERE workspace_id = $1', [workspaceId]);
      const rNoCh = await call('POST', '/api/webhooks/tiktok-dm', { messageId: 'dm-4', senderId: 'tt-user-4', text: 'হ্যালো', recipientId: 'tt-unknown' });
      check('DM with no channel is skipped (200, accepted=0)', rNoCh.status === 200 && rNoCh.data?.accepted === 0, `status=${rNoCh.status}, ${JSON.stringify(rNoCh.data)}`);

      const sent = await dm.sendTikTokDM(workspaceId, 'tt-user-1', 'test');
      check('sendTikTokDM with approval but no live client is stub-only (sent=false)', sent.sent === false && sent.stub === true && sent.reason === 'no_live_client', JSON.stringify(sent));
    }
  } catch (err) {
    check('harness completed without crashing', false, err.message);
  } finally {
    server.close();
    try { await pool.end(); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('__HARNESS_JSON_START__');
  console.log(JSON.stringify({ scenario, passed: results.length - failed.length, total: results.length, checks: results }));
  console.log('__HARNESS_JSON_END__');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.log('__HARNESS_JSON_START__');
  console.log(JSON.stringify({ scenario, passed: 0, total: 1, checks: [{ name: 'harness crashed', ok: false, detail: err.message }] }));
  console.log('__HARNESS_JSON_END__');
  process.exit(1);
});
