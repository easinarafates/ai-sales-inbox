import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth, requireWorkspaceOwner } from '../auth/auth';
import { callGroq } from '../ai-agent/groq';
import { invalidateWorkspacePromptCache } from '../ai-agent/gemini-cache';
import {
  buildOldProductKnowledgeBody,
  extractProductsFromPosts,
  fetchPagePosts,
  PageReadAuthError,
  PAGE_READ_RECONNECT_MESSAGE,
  type PageReadProductRow,
} from '../channels/page-read';
import { decryptPageToken, getWorkspacePageChannel } from '../channels/meta-send';

export const knowledgeRouter = Router();
knowledgeRouter.use(requireAuth);

/** GET /api/knowledge — the AI knowledge book. */
knowledgeRouter.get('/knowledge', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    'SELECT id, title, body, created_at FROM knowledge_items WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200',
    [workspaceId],
  );
  res.json({ knowledgeItems: rows });
});

knowledgeRouter.post('/knowledge', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { title, body } = (req.body ?? {}) as { title?: string; body?: string };
  if (!body || !body.trim()) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    'INSERT INTO knowledge_items (workspace_id, title, body) VALUES ($1, $2, $3) RETURNING id, title, body, created_at',
    [workspaceId, title ?? null, body.trim()],
  );
  // Knowledge is part of the AI's cached prompt prefix.
  await invalidateWorkspacePromptCache(workspaceId);
  res.status(201).json({ knowledgeItem: rows[0] });
});

knowledgeRouter.patch('/knowledge/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { title, body } = (req.body ?? {}) as { title?: string; body?: string };
  const { rows } = await query(
    workspaceId,
    `UPDATE knowledge_items SET title = COALESCE($1, title), body = COALESCE($2, body), updated_at = now()
     WHERE workspace_id = $3 AND id = $4 RETURNING id, title, body, created_at`,
    [title ?? null, body ?? null, workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Knowledge item not found' });
    return;
  }
  // Knowledge is part of the AI's cached prompt prefix.
  await invalidateWorkspacePromptCache(workspaceId);
  res.json({ knowledgeItem: rows[0] });
});

knowledgeRouter.delete('/knowledge/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rowCount } = await query(
    workspaceId,
    'DELETE FROM knowledge_items WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (rowCount === 0) {
    res.status(404).json({ error: 'Knowledge item not found' });
    return;
  }
  // Knowledge is part of the AI's cached prompt prefix.
  await invalidateWorkspacePromptCache(workspaceId);
  res.json({ deleted: true });
});

/** GET /api/unanswered — questions the AI could not answer (for the owner to fill in). */
knowledgeRouter.get('/unanswered', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    'SELECT id, question, count, taught, created_at, updated_at FROM unanswered_questions WHERE workspace_id = $1 ORDER BY count DESC, updated_at DESC LIMIT 200',
    [workspaceId],
  );
  res.json({ unanswered: rows });
});

/**
 * AI teaching tools (Module B, Phase 2 — PDF section 4, "AI-কে শেখানো").
 * Plain-language change -> AI preview -> owner approves -> saved, with the
 * previous body kept in knowledge_versions so one click rolls back.
 * Preview NEVER saves anything; apply saves the old body as a version first.
 */

/** Extract the reply text from a callGroq result (JSON {"reply": ...} or plain text). */
function groqReplyText(result: { text: string } | null): string | null {
  if (!result) return null;
  const text = result.text.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { reply?: string };
    if (parsed.reply) return parsed.reply.trim();
  } catch {
    // Plain-text reply — use it as-is.
  }
  return text;
}

/** POST /api/unanswered/:id/teach {answer} — teach the AI an answer it lacked. */
knowledgeRouter.post('/unanswered/:id/teach', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { answer } = (req.body ?? {}) as { answer?: string };
  if (!answer || !answer.trim()) {
    res.status(400).json({ error: 'answer is required' });
    return;
  }
  const { rows: unanswered } = await query<{ id: string; question: string }>(
    workspaceId,
    'SELECT id, question FROM unanswered_questions WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (unanswered.length === 0) {
    res.status(404).json({ error: 'Unanswered question not found' });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `INSERT INTO knowledge_items (workspace_id, title, body)
     VALUES ($1, $2, $3) RETURNING id, title, body, created_at`,
    [workspaceId, unanswered[0].question, answer.trim()],
  );
  await query(
    workspaceId,
    'UPDATE unanswered_questions SET taught = TRUE, updated_at = now() WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  // The new knowledge item is part of the AI's cached prompt prefix.
  await invalidateWorkspacePromptCache(workspaceId);
  res.status(201).json({ knowledgeItem: rows[0] });
});

/**
 * POST /api/knowledge/preview-change {knowledgeId?, instruction}
 * Rewrites the knowledge body per the plain-language instruction and returns
 * {preview} WITHOUT saving anything. Without a knowledgeId, drafts a new
 * knowledge text from the instruction alone. Without an AI key, returns the
 * current body (or the instruction) as the preview and says so.
 */
knowledgeRouter.post('/knowledge/preview-change', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { knowledgeId, instruction } = (req.body ?? {}) as {
    knowledgeId?: string;
    instruction?: string;
  };
  if (!instruction || !instruction.trim()) {
    res.status(400).json({ error: 'instruction is required' });
    return;
  }
  let currentBody: string | null = null;
  if (knowledgeId) {
    const { rows } = await query<{ body: string }>(
      workspaceId,
      'SELECT body FROM knowledge_items WHERE workspace_id = $1 AND id = $2',
      [workspaceId, knowledgeId],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Knowledge item not found' });
      return;
    }
    currentBody = rows[0].body;
  }
  const prompt = currentBody
    ? `নিচের ব্যবসার তথ্যটি এই নির্দেশ অনুযায়ী বদলে নতুন সংস্করণ লেখো। বাংলায় লেখো, দাম/স্টক/ছাড় বানিয়ে লিখো না — যা জানা নেই, তা বদলিয়ো না। শুধু নতুন লেখাটি দাও।\n\nনির্দেশ: ${instruction.trim()}\n\nবর্তমান লেখা:\n${currentBody}`
    : `নিচের নির্দেশ অনুযায়ী ব্যবসার নলেজ বুকের জন্য একটি ছোট তথ্য লেখো (বাংলায়)। দাম/স্টক/ছাড় বানিয়ে লিখো না।\n\nনির্দেশ: ${instruction.trim()}`;
  try {
    const preview = groqReplyText(await callGroq(prompt));
    if (preview) {
      res.json({ preview, aiGenerated: true });
      return;
    }
  } catch (err) {
    console.error('[knowledge] preview-change AI failed:', (err as Error).message);
  }
  res.json({
    preview: currentBody ?? instruction.trim(),
    aiGenerated: false,
    note: 'AI চাবি বসানো নেই বা AI উত্তর দিচ্ছে না, তাই কিছু বদলানো হয়নি — এটা শুধু বর্তমান লেখা।',
  });
});

/**
 * POST /api/knowledge/apply-change {knowledgeId, newBody}
 * Saves the previous body into knowledge_versions, then updates.
 */
knowledgeRouter.post('/knowledge/apply-change', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { knowledgeId, newBody } = (req.body ?? {}) as {
    knowledgeId?: string;
    newBody?: string;
  };
  if (!knowledgeId || !newBody || !newBody.trim()) {
    res.status(400).json({ error: 'knowledgeId and newBody are required' });
    return;
  }
  const { rows: current } = await query<{ id: string; title: string | null; body: string }>(
    workspaceId,
    'SELECT id, title, body FROM knowledge_items WHERE workspace_id = $1 AND id = $2',
    [workspaceId, knowledgeId],
  );
  if (current.length === 0) {
    res.status(404).json({ error: 'Knowledge item not found' });
    return;
  }
  const { rows: versions } = await query<{ id: string }>(
    workspaceId,
    `INSERT INTO knowledge_versions (workspace_id, knowledge_id, body)
     VALUES ($1, $2, $3) RETURNING id`,
    [workspaceId, knowledgeId, current[0].body],
  );
  const { rows } = await query(
    workspaceId,
    `UPDATE knowledge_items SET body = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3 RETURNING id, title, body, created_at`,
    [newBody.trim(), workspaceId, knowledgeId],
  );
  // Knowledge is part of the AI's cached prompt prefix.
  await invalidateWorkspacePromptCache(workspaceId);
  res.json({ knowledgeItem: rows[0], versionId: versions[0].id });
});

/**
 * GET /api/knowledge/:id/versions — earlier saved bodies for one item,
 * newest first. Lets the Teach page offer rollback across sessions
 * (previously only the version from the current browser session worked).
 */
knowledgeRouter.get('/knowledge/:id/versions', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query<{ id: string; body: string; created_at: string }>(
    workspaceId,
    `SELECT id, body, created_at FROM knowledge_versions
     WHERE workspace_id = $1 AND knowledge_id = $2 ORDER BY created_at DESC LIMIT 20`,
    [workspaceId, req.params.id],
  );
  res.json({ versions: rows });
});

/**
 * POST /api/knowledge/:id/rollback {versionId}
 * Restores the body from a knowledge_versions row. The current body is
 * saved as a new version first, so a rollback can itself be rolled back.
 */
knowledgeRouter.post('/knowledge/:id/rollback', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { versionId } = (req.body ?? {}) as { versionId?: string };
  if (!versionId) {
    res.status(400).json({ error: 'versionId is required' });
    return;
  }
  const { rows: versions } = await query<{ id: string; body: string }>(
    workspaceId,
    `SELECT id, body FROM knowledge_versions
     WHERE workspace_id = $1 AND id = $2 AND knowledge_id = $3`,
    [workspaceId, versionId, req.params.id],
  );
  if (versions.length === 0) {
    res.status(404).json({ error: 'Knowledge version not found' });
    return;
  }
  const { rows: current } = await query<{ body: string }>(
    workspaceId,
    'SELECT body FROM knowledge_items WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (current.length === 0) {
    res.status(404).json({ error: 'Knowledge item not found' });
    return;
  }
  await query(
    workspaceId,
    `INSERT INTO knowledge_versions (workspace_id, knowledge_id, body)
     VALUES ($1, $2, $3)`,
    [workspaceId, req.params.id, current[0].body],
  );
  const { rows } = await query(
    workspaceId,
    `UPDATE knowledge_items SET body = $1, updated_at = now()
     WHERE workspace_id = $2 AND id = $3 RETURNING id, title, body, created_at`,
    [versions[0].body, workspaceId, req.params.id],
  );
  // Knowledge is part of the AI's cached prompt prefix.
  await invalidateWorkspacePromptCache(workspaceId);
  res.json({ knowledgeItem: rows[0] });
});

/**
 * PAGE READ (Feature 2) — "পেজ পড়ুন": the AI learns the whole Facebook Page.
 *
 * The Page has OLD products sold long ago that are NOT in the website's
 * product list. The owner runs a read, reviews the PENDING products found,
 * and confirms each one — only confirmed items enter the knowledge book
 * (agent.ts loads knowledge_items into the AI's stable prompt, LIMIT 10
 * most recent, so a confirmed old product reaches the model through its
 * body wording — no agent change). All four endpoints are owner-only
 * (requireWorkspaceOwner, same as AI Providers / Task 14).
 *
 * Honesty: no connected Page / no token / Graph auth-scope failure
 * (the live Page token predates pages_read_engagement — the owner still
 * needs to reconnect Halal Chic once) returns a clear Bengali reconnect
 * message with needsReconnect: true and stores NOTHING. A price is
 * recorded only when a post states one; otherwise price_paisa stays null.
 */

/** Shared shape for the pending/confirmed product rows. */
function pageReadRow(r: PageReadProductRow): PageReadProductRow {
  return {
    id: r.id,
    name: r.name,
    price_paisa: r.price_paisa,
    description: r.description,
    photo_url: r.photo_url,
    source_post_id: r.source_post_id,
    source_post_url: r.source_post_url,
    post_created_at: r.post_created_at,
    status: r.status,
    knowledge_id: r.knowledge_id,
    created_at: r.created_at,
  };
}

/** POST /api/knowledge/page-read {limit?} — read the Page, store PENDING products. */
knowledgeRouter.post('/knowledge/page-read', requireWorkspaceOwner, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { limit } = (req.body ?? {}) as { limit?: number };
  // 1. Load the workspace's connected Facebook Page token (server-side,
  // from the channels table, decrypted — same helper as message sending).
  const channel = await getWorkspacePageChannel(workspaceId);
  if (!channel) {
    res.status(400).json({
      error: 'No connected Facebook Page',
      errorBn: PAGE_READ_RECONNECT_MESSAGE,
      needsReconnect: true,
    });
    return;
  }
  const pageToken = decryptPageToken(channel);
  if (!pageToken) {
    res.status(400).json({
      error: 'Stored Page token could not be read',
      errorBn: PAGE_READ_RECONNECT_MESSAGE,
      needsReconnect: true,
    });
    return;
  }
  // 2. Fetch the Page's post history from the Graph API (never faked).
  let posts;
  try {
    posts = await fetchPagePosts(channel.external_id, pageToken, limit ?? 300);
  } catch (err) {
    if (err instanceof PageReadAuthError) {
      res.status(502).json({
        error: 'Facebook rejected the Page token (auth/scope)',
        errorBn: (err as Error).message,
        needsReconnect: true,
      });
      return;
    }
    console.error('[page-read] Graph fetch failed:', (err as Error).message);
    res.status(502).json({
      error: 'Facebook page read failed',
      errorBn: `পেজটি পড়া যায়নি: ${(err as Error).message} কিছুই সংরক্ষণ করা হয়নি — আবার চেষ্টা করুন।`,
      needsReconnect: false,
    });
    return;
  }
  // 3. Extract candidate products with Gemini Lite (regex fallback when
  // Gemini is unavailable — the response says which path was used).
  const { products, extraction } = await extractProductsFromPosts(posts);
  // 4. Store as PENDING — skip products already seen (same post, or the
  // same name already pending/confirmed) so a re-read never duplicates.
  const { rows: existing } = await query<{ name: string; source_post_id: string | null }>(
    workspaceId,
    `SELECT name, source_post_id FROM page_read_products
     WHERE workspace_id = $1 AND status IN ('pending', 'confirmed')`,
    [workspaceId],
  );
  const seenPosts = new Set(existing.map((e) => e.source_post_id).filter(Boolean));
  const seenNames = new Set(existing.map((e) => e.name.trim().toLowerCase()));
  let inserted = 0;
  let skipped = 0;
  const items: PageReadProductRow[] = [];
  for (const p of products) {
    if (seenPosts.has(p.sourcePostId) || seenNames.has(p.name.trim().toLowerCase())) {
      skipped += 1;
      continue;
    }
    seenPosts.add(p.sourcePostId);
    seenNames.add(p.name.trim().toLowerCase());
    const { rows } = await query<PageReadProductRow>(
      workspaceId,
      `INSERT INTO page_read_products
         (workspace_id, name, price_paisa, description, photo_url, source_post_id, source_post_url, post_created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, price_paisa, description, photo_url, source_post_id, source_post_url, post_created_at, status, knowledge_id, created_at`,
      [
        workspaceId,
        p.name,
        p.pricePaisa,
        p.description || null,
        p.photoUrl,
        p.sourcePostId,
        p.sourcePostUrl,
        p.postCreatedAt,
      ],
    );
    if (rows[0]) {
      items.push(pageReadRow(rows[0]));
      inserted += 1;
    }
  }
  res.json({
    postsScanned: posts.length,
    productsFound: products.length,
    inserted,
    skipped,
    extraction,
    items,
    message:
      inserted > 0
        ? `${posts.length}টি পোস্ট পড়া হয়েছে, ${inserted}টি নতুন পণ্য পাওয়া গেছে। নিচে দেখে প্রতিটি নিশ্চিত করুন — নিশ্চিত না করা পর্যন্ত AI এগুলো শিখবে না।`
        : `${posts.length}টি পোস্ট পড়া হয়েছে, নতুন কোনো পণ্য পাওয়া যায়নি।`,
  });
});

/** GET /api/knowledge/page-read — pending products awaiting owner review. */
knowledgeRouter.get('/knowledge/page-read', requireWorkspaceOwner, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  const allowed = ['pending', 'confirmed', 'rejected'];
  const filter = allowed.includes(status) ? status : 'pending';
  const { rows } = await query<PageReadProductRow>(
    workspaceId,
    `SELECT id, name, price_paisa, description, photo_url, source_post_id, source_post_url, post_created_at, status, knowledge_id, created_at
     FROM page_read_products WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 200`,
    [workspaceId, filter],
  );
  res.json({ items: rows.map(pageReadRow), status: filter });
});

/** POST /api/knowledge/page-read/:id/confirm {name?, pricePaisa?, description?, photoUrl?} */
knowledgeRouter.post('/knowledge/page-read/:id/confirm', requireWorkspaceOwner, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { name, pricePaisa, description, photoUrl } = (req.body ?? {}) as {
    name?: string;
    pricePaisa?: number | null;
    description?: string;
    photoUrl?: string | null;
  };
  const { rows } = await query<PageReadProductRow>(
    workspaceId,
    `SELECT id, name, price_paisa, description, photo_url, source_post_id, source_post_url, post_created_at, status, knowledge_id, created_at
     FROM page_read_products WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Page-read product not found' });
    return;
  }
  const item = rows[0];
  if (item.status === 'confirmed') {
    res.status(400).json({ error: 'This product was already confirmed' });
    return;
  }
  if (item.status === 'rejected') {
    res.status(400).json({ error: 'This product was rejected — it cannot be confirmed' });
    return;
  }
  const finalName = (name ?? item.name).trim();
  if (!finalName) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const finalPrice =
    pricePaisa === undefined ? item.price_paisa : pricePaisa === null ? null : Math.round(pricePaisa);
  const finalDescription = description === undefined ? item.description : description || null;
  const finalPhoto = photoUrl === undefined ? item.photo_url : photoUrl || null;
  // The knowledge body carries the old-product guard in its own wording
  // (agent.ts loads knowledge_items into the AI prompt as-is).
  const body = buildOldProductKnowledgeBody({
    name: finalName,
    price_paisa: finalPrice,
    description: finalDescription,
    photo_url: finalPhoto,
    source_post_url: item.source_post_url,
    priceEdited: finalPrice !== item.price_paisa,
  });
  const { rows: knowledge } = await query(
    workspaceId,
    `INSERT INTO knowledge_items (workspace_id, title, body) VALUES ($1, $2, $3)
     RETURNING id, title, body, created_at`,
    [workspaceId, finalName, body],
  );
  await query(
    workspaceId,
    `UPDATE page_read_products
     SET status = 'confirmed', name = $1, price_paisa = $2, description = $3, photo_url = $4,
         knowledge_id = $5, updated_at = now()
     WHERE workspace_id = $6 AND id = $7`,
    [finalName, finalPrice, finalDescription, finalPhoto, knowledge[0].id, workspaceId, req.params.id],
  );
  // Knowledge is part of the AI's cached prompt prefix.
  await invalidateWorkspacePromptCache(workspaceId);
  res.json({ knowledgeItem: knowledge[0], item: { ...pageReadRow(item), status: 'confirmed', knowledge_id: knowledge[0].id } });
});

/** POST /api/knowledge/page-read/:id/reject — owner rejects a found product. */
knowledgeRouter.post('/knowledge/page-read/:id/reject', requireWorkspaceOwner, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rowCount } = await query(
    workspaceId,
    `UPDATE page_read_products SET status = 'rejected', updated_at = now()
     WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`,
    [workspaceId, req.params.id],
  );
  if (rowCount === 0) {
    res.status(404).json({ error: 'Pending page-read product not found' });
    return;
  }
  res.json({ rejected: true });
});

/** DELETE /api/knowledge/page-read/:id — permanently remove a found product. */
knowledgeRouter.delete('/knowledge/page-read/:id', requireWorkspaceOwner, async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rowCount } = await query(
    workspaceId,
    'DELETE FROM page_read_products WHERE workspace_id = $1 AND id = $2',
    [workspaceId, req.params.id],
  );
  if (rowCount === 0) {
    res.status(404).json({ error: 'Page-read product not found' });
    return;
  }
  res.json({ deleted: true });
});
