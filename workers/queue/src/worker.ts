/**
 * BullMQ worker for 'inbox-messages' (Phase 1) + 'scheduled-posts'
 * (Phase 2) with a 60s sweep for due scheduled posts and follow-ups.
 *
 * Flow: webhook (API) saves the inbound message and enqueues a debounced job
 * (jobId per conversation + 1s delay) -> this worker picks it up, reloads the
 * latest inbound messages for the conversation from the DB, and calls the
 * API's AI agent (processBatch) to answer them as one batch.
 *
 * The agent is imported from the API package via relative path (see README).
 * Run: `npm install && npm run build && npm start` (or `npm run dev`).
 * Requires: Postgres + Redis running (infra/docker-compose.yml) and a .env
 * with DATABASE_URL / REDIS_URL / GEMINI_API_KEY / JWT_SECRET /
 * TOKEN_ENCRYPTION_KEY (same values as the API).
 *
 * PGlite local mode: do NOT run this worker — the API itself sweeps due
 * scheduled posts + follow-ups every 60s (see apps/api/src/index.ts),
 * because the PGlite data folder can be opened by only one process.
 */
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { pool, query } from '../../../apps/api/src/db/pool';
import { processBatch, type BatchedMessage } from '../../../apps/api/src/ai-agent/agent';
import { config } from '../../../apps/api/src/config';
import type { InboxJobData } from './queue';
import { processDueFollowups } from '../../../apps/api/src/followups/engine';
import { processDueHandovers } from '../../../apps/api/src/handover/engine';
import { processDueScheduledPosts, publishScheduledPost } from '../../../apps/api/src/scheduling/publisher';
import { processOwnerWalletDeductions } from '../../../apps/api/src/owner/sweep';
import type { ScheduledPostJobData } from '../../../apps/api/src/scheduling/queue';

async function redisAvailable(): Promise<boolean> {
  const test = new IORedis(config.redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    retryStrategy: () => null,
  });
  try {
    await Promise.race([
      test.ping(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('ping timeout')), 3000)),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    test.disconnect();
  }
}

async function main(): Promise<void> {
  // No Redis here → the API's in-process queue fallback (see
  // apps/api/src/queue/client.ts) already processes messages, so the
  // worker is not needed. Exit cleanly instead of crash-looping.
  if (!(await redisAvailable())) {
    console.log('[worker] Redis is not reachable — worker not needed: the API processes inbox messages in-process. Exiting.');
    await pool.end().catch(() => undefined);
    process.exit(0);
  }
  startWorker();
}

function startWorker(): void {
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<InboxJobData>(
    'inbox-messages',
    async (job) => {
      const { workspaceId, conversationId } = job.data;
      // Reload the recent inbound messages — this is what makes the 1s debounce
      // a true batch: messages that arrived while the job was delayed are included.
      const { rows } = await query<{ body: string | null }>(
        workspaceId,
        `SELECT body FROM messages
         WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'in'
         ORDER BY created_at DESC LIMIT 10`,
        [workspaceId, conversationId],
      );
      const batched: BatchedMessage[] = [...rows].reverse().map((r) => ({ body: r.body ?? '' }));
      if (batched.length === 0) return { replied: false, reason: 'no_messages' };
      const result = await processBatch(workspaceId, conversationId, batched);
      console.log(`[worker] conv ${conversationId}:`, result);
      return result;
    },
    { connection, concurrency: 5 },
  );

  worker.on('completed', (job) => console.log(`[worker] job ${job.id} completed`));
  worker.on('failed', (job, err) => console.error(`[worker] job ${job?.id} failed:`, err.message));

  // Phase 2/3: scheduled-post publishing (BullMQ queue 'scheduled-posts').
  // Job data carries workspaceId; fall back to a DB lookup if it is absent.
  const postsWorker = new Worker<ScheduledPostJobData>(
    'scheduled-posts',
    async (job) => {
      let workspaceId = job.data.workspaceId;
      const { postId } = job.data;
      if (!workspaceId) {
        const { rows } = await pool.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM scheduled_posts WHERE id = $1',
          [postId],
        );
        workspaceId = rows[0]?.workspace_id;
        if (!workspaceId) throw new Error(`Scheduled post not found: ${postId}`);
      }
      const post = await publishScheduledPost(workspaceId, postId);
      return { postId, status: post.status };
    },
    { connection, concurrency: 3 },
  );
  postsWorker.on('completed', (job) => console.log(`[worker] scheduled post job ${job.id} completed`));
  postsWorker.on('failed', (job, err) => console.error(`[worker] scheduled post job ${job?.id} failed:`, err.message));

  // Every 60s, sweep due scheduled posts + due follow-ups + expired
  // human handovers (covers posts whose delayed job was lost, follow-ups
  // with no queue job, and handovers whose timer expired).
  const sweep = setInterval(async () => {
    try {
      const posts = await processDueScheduledPosts();
      const followups = await processDueFollowups();
      const handovers = await processDueHandovers();
      const ownerCosts = await processOwnerWalletDeductions();
      if (posts.processed > 0 || followups.processed > 0 || handovers.returned > 0 || ownerCosts.deductedRows > 0) {
        console.log('[worker] sweep:', { posts, followups, handovers, ownerCosts });
      }
    } catch (err) {
      console.error('[worker] sweep failed:', (err as Error).message);
    }
  }, 60_000);
  sweep.unref?.();

  async function shutdown(): Promise<void> {
    console.log('[worker] shutting down…');
    clearInterval(sweep);
    await postsWorker.close();
    await worker.close();
    await pool.end();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[worker] inbox-messages + scheduled-posts workers running (concurrency 5 / 3)');
}

main().catch((err) => {
  console.error('[worker] failed to start:', (err as Error).message);
  process.exit(1);
});
