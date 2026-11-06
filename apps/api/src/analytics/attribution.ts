/**
 * Post attribution helpers — the post <-> conversation <-> order link.
 *
 * A comment (Facebook/Instagram/TikTok) carries only the PLATFORM post id
 * (comments.platform_post_id, e.g. the stub id from publish-now). The
 * scheduled post is resolved from that id, then one row is recorded in
 * post_attributions (migration 05-post-attribution.sql). The row is
 * idempotent (UNIQUE workspace_id + post_id + conversation_id, ON
 * CONFLICT DO NOTHING), so recording it twice — e.g. from the webhook
 * AND from the comment-reply handler — is harmless.
 *
 * Orders: when an order is created from a conversation
 * (team order in orders/routes.ts, or the AI create_order tool in
 * ai-agent/tools.ts), linkOrderToAttribution stamps order_id onto the
 * attribution row(s) for that conversation. The analytics endpoint
 * ALSO counts orders via orders.conversation_id, so an order is counted
 * even if its order_id was never stamped (e.g. created before this
 * migration existed).
 *
 * Every query filters by workspace_id. Attribution failures must never
 * break the caller (webhook / order creation) — callers wrap these in
 * try/catch and log only.
 */

export interface AttributionDb {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

/** Resolve a scheduled post's id from its platform post id (stub-...). */
export async function resolveScheduledPostId(
  db: AttributionDb,
  workspaceId: string,
  platformPostId: string | null | undefined,
): Promise<string | null> {
  if (!platformPostId) return null;
  const { rows } = await db.query(
    'SELECT id FROM scheduled_posts WHERE workspace_id = $1 AND platform_post_id = $2 ORDER BY created_at DESC LIMIT 1',
    [workspaceId, platformPostId],
  );
  return (rows[0]?.id as string | undefined) ?? null;
}

/** Record one post -> conversation attribution (idempotent). */
export async function recordPostAttribution(
  db: AttributionDb,
  workspaceId: string,
  scheduledPostId: string,
  conversationId: string,
  source: string = 'comment',
): Promise<void> {
  await db.query(
    `INSERT INTO post_attributions (workspace_id, post_id, conversation_id, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, post_id, conversation_id) DO NOTHING`,
    [workspaceId, scheduledPostId, conversationId, source],
  );
}

/**
 * Resolve the scheduled post from a comment's platform_post_id and record
 * the attribution. Returns the scheduled post id, or null when the comment
 * does not belong to any scheduled post in this workspace (e.g. a comment
 * on an old post published outside this app — nothing to attribute).
 */
export async function recordAttributionForPlatformPost(
  db: AttributionDb,
  workspaceId: string,
  platformPostId: string | null | undefined,
  conversationId: string,
  source: string = 'comment',
): Promise<string | null> {
  const postId = await resolveScheduledPostId(db, workspaceId, platformPostId);
  if (!postId) return null;
  await recordPostAttribution(db, workspaceId, postId, conversationId, source);
  return postId;
}

/**
 * Stamp order_id onto the attribution row(s) of a conversation.
 * Only rows that have no order yet are updated, so the FIRST order from
 * a conversation is the one linked (later orders from the same
 * conversation still count in analytics via orders.conversation_id).
 */
export async function linkOrderToAttribution(
  db: AttributionDb,
  workspaceId: string,
  orderId: string,
  conversationId: string | null | undefined,
): Promise<void> {
  if (!conversationId) return;
  await db.query(
    `UPDATE post_attributions SET order_id = $3, updated_at = now()
     WHERE workspace_id = $1 AND conversation_id = $2 AND order_id IS NULL`,
    [workspaceId, conversationId, orderId],
  );
}
