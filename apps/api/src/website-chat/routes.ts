import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { pool, query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

/**
 * Website chat widget (Worker B).
 * - GET /api/website-chat/settings (auth): the workspace's public key + copy-paste snippet.
 * - GET /api/website-chat/widget.js?key=... (public): embeddable JS that renders
 *   a chat box on any site and posts to the public message endpoint.
 * - POST /api/website-chat/message (public): {workspaceKey, text, visitorName?}
 *   creates a conversation visible in the inbox. The public key identifies
 *   the workspace only — it is NOT an auth token and cannot read anything.
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
  open.addEventListener('click', function () {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    open.style.display = panel.style.display === 'none' ? 'inline-block' : 'none';
  });
  function addLine(who, text) {
    var p = document.createElement('p');
    p.style.margin = '6px 0';
    p.textContent = who + ': ' + text;
    log.appendChild(p);
    log.scrollTop = log.scrollHeight;
  }
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
        else addLine('\\u09a6\\u09cb\\u0995', '\\u09a7\\u09a8\\u09cd\\u09af\\u09ac\\u09be\\u09a6! \\u0986\\u09ae\\u09be\\u09b0 \\u099f\\u09bf\\u09ae \\u0989\\u09a4\\u09cd\\u09a4\\u09b0 \\u09a6\\u09c7\\u09ac\\u09c7\\u0964');
      })
      .catch(function () { addLine('\\u09a6\\u09cb\\u0995', '\\u09aa\\u09be\\u09a0\\u09be\\u09a8\\u09cb \\u09af\\u09be\\u09df\\u099b\\u09c7; \\u0986\\u09ac\\u09be\\u09b0 \\u099a\\u09c7\\u09b7\\u09cd\\u099f\\u09be \\u0995\\u09b0\\u09c1\\u09a8\\u0964'); });
  });
})();`;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(js);
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
  res.status(201).json({ conversationId: conversation.id, message: msgRows[0] });
});
