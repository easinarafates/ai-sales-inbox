import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { enqueueMessage } from '../queue/client';
import { checkFixedWindow, clientIp } from '../utils/rate-limit';

/**
 * Website chat widget (Worker B).
 * - GET /api/website-chat/settings (auth): the workspace's public key + copy-paste snippet.
 * - GET /api/website-chat/widget.js?key=... (public): embeddable JS that renders
 *   a chat box on any site and posts to the public message endpoint. It
 *   polls GET /api/website-chat/messages for the AI's replies.
 * - POST /api/website-chat/message (public): {workspaceKey, text, visitorName?}
 *   creates a conversation visible in the inbox AND enqueues it for the
 *   SAME AI pipeline Messenger/Instagram use (queue/client.enqueueMessage
 *   -> ai-agent/processBatch -> deliverOutgoingMessage, which for a
 *   'webchat' channel counts saving the reply as delivery). Before this
 *   fix the message was only inserted — no enqueue, so no AI reply ever
 *   fired — and the widget never fetched replies, so even a reply in the
 *   DB could never reach the visitor.
 * - GET /api/website-chat/messages?key=...&conversationId=... (public):
 *   the visitor's poll endpoint — messages of that one conversation only,
 *   scoped by the workspace key. The key identifies the workspace only —
 *   it is NOT an auth token and cannot read anything else.
 */
export const websiteChatRouter = Router();

function apiBase(req: Request): string {
  const base = (process.env.API_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (base) return base;
  return `${req.protocol}://${req.get('host') ?? 'localhost:4000'}`;
}

function snippetFor(req: Request, publicKey: string): string {
  return `<script src="${apiBase(req)}/api/website-chat/widget.js?key=${publicKey}" async></script>`;
}

async function getOrCreateKey(workspaceId: string): Promise<string> {
  const existing = await queryOne<{ public_key: string }>(
    workspaceId,
    'SELECT public_key FROM website_chat_keys WHERE workspace_id = $1',
    [workspaceId],
  );
  if (existing) return existing.public_key;
  const publicKey = `wk_${randomBytes(16).toString('hex')}`;
  const { rows } = await query<{ public_key: string }>(
    workspaceId,
    `INSERT INTO website_chat_keys (workspace_id, public_key)
     VALUES ($1, $2)
     ON CONFLICT (workspace_id) DO UPDATE SET public_key = EXCLUDED.public_key
     RETURNING public_key`,
    [workspaceId, publicKey],
  );
  return rows[0].public_key;
}

/** GET /api/website-chat/settings — public key + snippet (auth). */
websiteChatRouter.get('/website-chat/settings', requireAuth, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const publicKey = await getOrCreateKey(workspaceId);
  res.json({
    publicKey,
    snippet: snippetFor(req, publicKey),
    note: 'Paste this snippet on your website. Visitors can chat; their messages appear in your inbox. The key only identifies your shop — it cannot log in or read data.',
  });
});

/** GET /api/website-chat/widget.js?key=... — public embeddable widget. */
websiteChatRouter.get('/website-chat/widget.js', async (req: Request, res: Response) => {
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const base = apiBase(req);
  const js = `(function () {
  var KEY = ${JSON.stringify(key)};
  var API = ${JSON.stringify(base)};
  if (!KEY) return;
  var box = document.createElement('div');
  box.id = 'ai-inbox-chat';
  box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;font-family:sans-serif;';
  box.innerHTML =
    '<button id="ai-inbox-open" style="background:#ff6a4d;color:#fff;border:0;border-radius:999px;padding:12px 18px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);">\\u099a\\u09be\\u099f \\u0995\\u09b0\\u09c1\\u09a8</button>' +
    '<div id="ai-inbox-panel" style="display:none;width:300px;max-width:90vw;background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);overflow:hidden;margin-bottom:10px;">' +
    '<div style="background:#ff6a4d;color:#fff;padding:12px;font-weight:bold;">\\u099a\\u09be\\u099f \\u0995\\u09b0\\u09c1\\u09a8</div>' +
    '<div id="ai-inbox-log" style="height:220px;overflow:auto;padding:10px;font-size:14px;"></div>' +
    '<div style="display:flex;border-top:1px solid #eee;">' +
    '<input id="ai-inbox-text" placeholder="\\u09ae\\u09c7\\u09b8\\u09be \\u09b2\\u09bf\\u0996\\u09c1\\u09a8..." style="flex:1;border:0;padding:10px;outline:none;font-size:14px;" />' +
    '<button id="ai-inbox-send" style="background:#0f766e;color:#fff;border:0;padding:0 14px;cursor:pointer;">\\u09aa\\u09be\\u09a0\\u09be\\u09a8</button>' +
    '</div></div>';
  document.body.appendChild(box);
  var open = document.getElementById('ai-inbox-open');
  var panel = document.getElementById('ai-inbox-panel');
  var log = document.getElementById('ai-inbox-log');
  var input = document.getElementById('ai-inbox-text');
  var convId = null;
  try { convId = window.localStorage.getItem('ai-inbox-conv') || null; } catch (e) { convId = null; }
  var shown = {};
  var polling = false;
  open.addEventListener('click', function () {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    open.style.display = panel.style.display === 'none' ? 'inline-block' : 'none';
    if (panel.style.display !== 'none') poll();
  });
  function addLine(who, text) {
    var p = document.createElement('p');
    p.style.margin = '6px 0';
    p.textContent = who + ': ' + text;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }
  // Visitor delivery path: the AI reply is saved on the server (for a
  // webchat channel, saving IS the delivery) and the widget polls for
  // it here — without this poll the reply would sit in the DB and the
  // visitor would never see it.
  function poll() {
    if (!convId) return;
    fetch(API + '/api/website-chat/messages?key=' + encodeURIComponent(KEY) + '&conversationId=' + encodeURIComponent(convId))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var msgs = (d && d.messages) || [];
        msgs.forEach(function (m) {
          if (m.direction !== 'out' || shown[m.id]) return;
          shown[m.id] = true;
          addLine('\\u09a6\\u09cb\\u0995\\u09be\\u09a8', m.body);
        });
      })
      .catch(function () { /* next poll retries */ });
  }
  if (convId) { polling = true; setInterval(poll, 3000); }
  document.getElementById('ai-inbox-send').addEventListener('click', function () {
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    addLine('\\u0986\\u09aa\\u09a8\\u09bf', text);
    fetch(API + '/api/website-chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceKey: KEY, text: text }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.error) addLine('\\u09a6\\u09cb\\u0995', d.error);
        else {
          addLine('\\u09a6\\u09cb\\u0995', '\\u09a7\\u09a8\\u09cd\\u09af\\u09ac\\u09be\\u09a6! \\u0986\\u09ae\\u09be\\u09b0 \\u099f\\u09bf\\u09ae \\u0989\\u09a4\\u09cd\\u09a4\\u09b0 \\u09a6\\u09c7\\u09ac\\u09c7\\u0964');
          if (d && d.conversationId) {
            convId = d.conversationId;
            try { window.localStorage.setItem('ai-inbox-conv', convId); } catch (e) { /* private mode */ }
            if (!polling) { polling = true; setInterval(poll, 3000); }
            poll();
          }
        }
      })
      .catch(function () { addLine('\\u09a6\\u09cb\\u0995', '\\u09aa\\u09be\\u09a0\\u09be\\u09a8\\u09cb \\u09af\\u09be\\u09df\\u099b\\u09c7; \\u0986\\u09ac\\u09be\\u09b0 \\u099a\\u09c7\\u09b7\\u09cd\\u099f\\u09be \\u0995\\u09b0\\u09c1\\u09a8\\u0964'); });
  });
})();`;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(js);
});

/** GET /api/website-chat/messages?key=...&conversationId=... — public visitor poll.
 * Returns ONLY the messages of the one conversation named, and only when
 * that conversation belongs to the workspace the key identifies. A wrong
 * key or a conversation from another workspace gets 404 — the key can
 * never enumerate or read other visitors' chats. `since` (ISO timestamp,
 * optional) returns only newer messages, so polling stays cheap. */
websiteChatRouter.get('/website-chat/messages', async (req: Request, res: Response) => {
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
  const since = typeof req.query.since === 'string' ? req.query.since : '';
  if (!key || !conversationId) {
    res.status(400).json({ error: 'key and conversationId are required' });
    return;
  }
  if (!checkFixedWindow(`webchat-poll:${clientIp(req)}:${key}`, 120, 60 * 1000)) {
    res.status(429).json({ error: 'Too many requests — please wait a moment.' });
    return;
  }
  const keyRes = await pool.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM website_chat_keys WHERE public_key = $1',
    [key],
  );
  const keyRow = keyRes.rows[0] ?? null;
  if (!keyRow) {
    res.status(404).json({ error: 'Unknown workspace key' });
    return;
  }
  const workspaceId = keyRow.workspace_id;
  const conv = await queryOne<{ id: string }>(
    workspaceId,
    'SELECT id FROM conversations WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversationId],
  );
  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }
  const params: unknown[] = [workspaceId, conversationId];
  let sinceClause = '';
  if (since) {
    const sinceDate = new Date(since);
    if (!Number.isNaN(sinceDate.getTime())) {
      params.push(sinceDate.toISOString());
      sinceClause = ' AND created_at > $3';
    }
  }
  const { rows } = await query<{ id: string; direction: string; type: string; body: string; created_at: string }>(
    workspaceId,
    `SELECT id, direction, type, body, created_at FROM messages
     WHERE workspace_id = $1 AND conversation_id = $2${sinceClause}
     ORDER BY created_at ASC, id ASC LIMIT 100`,
    params,
  );
  res.json({ conversationId: conv.id, messages: rows });
});

/** POST /api/website-chat/message — public; creates an inbox conversation. */
websiteChatRouter.post('/website-chat/message', async (req: Request, res: Response) => {
  const { workspaceKey, text, visitorName } = (req.body ?? {}) as {
    workspaceKey?: string;
    text?: string;
    visitorName?: string;
  };
  if (!workspaceKey || typeof workspaceKey !== 'string') {
    res.status(400).json({ error: 'workspaceKey is required' });
    return;
  }
  if (!text || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  // M3 (security fix 2026-11-11): this box is public (no login), so it
  // needs limits — before this fix anyone could send unlimited messages
  // of any length and impersonate any visitor by name. Cap the text,
  // cap the name, and rate-limit per visitor key + per IP.
  // PLUS a per-widget-key bucket (60/min, any IP): the IP keys alone
  // cannot stop a spammer who rotates source IPs (live-verified
  // 2026-11-11: 21 requests from rotating IPs never hit one IP bucket).
  // 60/min per widget is far above any real shop's chat volume.
  if (text.trim().length > 2000) {
    res.status(400).json({ error: 'Message is too long (max 2000 characters)' });
    return;
  }
  if (typeof visitorName === 'string' && visitorName.trim().length > 100) {
    res.status(400).json({ error: 'Name is too long (max 100 characters)' });
    return;
  }
  const ip = clientIp(req);
  if (
    !checkFixedWindow(`webchat:${ip}:${workspaceKey}`, 20, 60 * 1000) ||
    !checkFixedWindow(`webchat-ip:${ip}`, 60, 60 * 1000) ||
    !checkFixedWindow(`webchat-key:${workspaceKey}`, 60, 60 * 1000)
  ) {
    res.status(429).json({ error: 'Too many messages — please wait a minute and try again.' });
    return;
  }
  // Public key lookup is unscoped by nature (no JWT yet — the key is what
  // identifies the workspace). pool.query is used directly, as in
  // signup/login: the key grants no read access, only message intake.
  const keyRes = await pool.query<{ workspace_id: string }>(
    'SELECT workspace_id FROM website_chat_keys WHERE public_key = $1',
    [workspaceKey],
  );
  const keyRow = keyRes.rows[0] ?? null;
  if (!keyRow) {
    res.status(400).json({ error: 'Unknown workspace key' });
    return;
  }
  const workspaceId = keyRow.workspace_id;
  const name = typeof visitorName === 'string' && visitorName.trim() ? visitorName.trim() : 'Website visitor';

  // Find or create the webchat channel for this workspace.
  let channel = await queryOne<{ id: string }>(
    workspaceId,
    `SELECT id FROM channels WHERE workspace_id = $1 AND platform = 'webchat' ORDER BY created_at ASC LIMIT 1`,
    [workspaceId],
  );
  if (!channel) {
    const { rows } = await query<{ id: string }>(
      workspaceId,
      `INSERT INTO channels (workspace_id, platform, external_id, display_name, status)
       VALUES ($1, 'webchat', 'website-chat', 'Website chat', 'connected') RETURNING id`,
      [workspaceId],
    );
    channel = rows[0];
  }

  // Find or create the visitor customer (matched by name + webchat identity).
  let customer = await queryOne<{ id: string }>(
    workspaceId,
    `SELECT id FROM customers WHERE workspace_id = $1 AND name = $2 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, name],
  );
  if (!customer) {
    const { rows } = await query<{ id: string }>(
      workspaceId,
      `INSERT INTO customers (workspace_id, name, channel_identities)
       VALUES ($1, $2, '[{"platform":"website"}]'::jsonb) RETURNING id`,
      [workspaceId, name],
    );
    customer = rows[0];
  }

  let conversation = await queryOne<{ id: string }>(
    workspaceId,
    `SELECT id FROM conversations WHERE workspace_id = $1 AND customer_id = $2 AND status = 'open'
     ORDER BY updated_at DESC LIMIT 1`,
    [workspaceId, customer.id],
  );
  if (!conversation) {
    const { rows } = await query<{ id: string }>(
      workspaceId,
      `INSERT INTO conversations (workspace_id, channel_id, customer_id, status, mode)
       VALUES ($1, $2, $3, 'open', 'ai') RETURNING id`,
      [workspaceId, channel.id, customer.id],
    );
    conversation = rows[0];
  }
  const { rows: msgRows } = await query(
    workspaceId,
    `INSERT INTO messages (workspace_id, conversation_id, direction, type, body)
     VALUES ($1, $2, 'in', 'text', $3) RETURNING id, direction, type, body, created_at`,
    [workspaceId, conversation.id, text.trim()],
  );
  await query(
    workspaceId,
    'UPDATE conversations SET updated_at = now() WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversation.id],
  );
  // THE FIX (2026-11-11): enqueue into the SAME AI pipeline Messenger /
  // Instagram / the webchat webhook use — enqueueMessage -> processBatch
  // (workspace ai_enabled + conversation mode='ai' are honoured there,
  // the cached-prompt Gemini call runs there, the reply is charged to
  // the ledger there, and deliverOutgoingMessage saves it for a
  // 'webchat' channel, which IS the delivery the widget polls for).
  // Before this, the message was only inserted and no reply ever fired.
  // Awaited like the webhooks do; a queue failure is logged, never a
  // 500 — the message itself is already saved in the inbox.
  await enqueueMessage(workspaceId, conversation.id, text.trim()).catch((err) =>
    console.error('[website-chat] enqueue failed:', (err as Error).message),
  );
  res.status(201).json({ conversationId: conversation.id, message: msgRows[0] });
});
