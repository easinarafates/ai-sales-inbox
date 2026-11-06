import { waitUntil } from '@vercel/functions';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';

export interface InboxJobData {
  workspaceId: string;
  conversationId: string;
  /** Latest inbound text (informational — the worker reloads history from the DB). */
  text?: string;
}

// Redis is optional: if it is down, BullMQ cannot queue, so the API falls
// back to processing the message in-process (same 3s debounce, same agent).
// The connection never retries forever and never crashes the process.
const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
  retryStrategy: (times: number) => (times > 3 ? null : 200),
});
connection.on('error', () => {
  /* Redis down — enqueueMessage() falls back in-process; logged once there. */
});

let redisDownLogged = false;
let queueUsable: boolean | null = null;

export const inboxQueue = new Queue<InboxJobData>('inbox-messages', { connection });

export function getQueue(): Queue<InboxJobData> {
  return inboxQueue;
}

async function processInProcess(
  workspaceId: string,
  conversationId: string,
  text?: string,
): Promise<void> {
  // Same 3s debounce as the BullMQ job: messages from the same customer
  // arriving within 3 seconds batch into one run, because the agent reloads
  // the full recent history from the DB when it runs.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    const { processBatch } = await import('../ai-agent/agent');
    const { query } = await import('../db/pool');
    const { rows } = await query<{ body: string | null }>(
      workspaceId,
      `SELECT body FROM messages
       WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'in'
       ORDER BY created_at DESC LIMIT 10`,
      [workspaceId, conversationId],
    );
    const batched = [...rows].reverse().map((r) => ({ body: r.body ?? '' }));
    if (batched.length === 0) return;
    const result = await processBatch(workspaceId, conversationId, batched);
    console.log(`[queue:fallback] conv ${conversationId}:`, result);
  } catch (err) {
    console.error('[queue:fallback] in-process processing failed:', (err as Error).message);
  }
}

/**
 * Enqueue a conversation for AI processing, debounced.
 * Same jobId per conversation + 3s delay: messages from the same customer
 * arriving within 3 seconds batch into one job, because the worker reloads
 * the full recent history from the DB when the job runs (so a duplicate
 * enqueue for an already-delayed job is safely ignored).
 *
 * If Redis is unavailable, the message is processed in-process instead —
 * the chat still gets an answer; only queue persistence is lost.
 */
export async function enqueueMessage(
  workspaceId: string,
  conversationId: string,
  text?: string,
): Promise<void> {
  if (queueUsable !== false) {
    try {
      await Promise.race([
        inboxQueue.add(
          'process',
          { workspaceId, conversationId, text },
          {
            jobId: `conv-${conversationId}`,
            delay: 3000,
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        ),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('queue add timed out')), 2000),
        ),
      ]);
      queueUsable = true;
      return;
    } catch (err) {
      // A delayed job for this conversation already exists — the new message
      // will be picked up with it when the worker reloads history. Not an error.
      if (/already exists|duplicate/i.test((err as Error).message)) return;
      queueUsable = false;
      if (!redisDownLogged) {
        redisDownLogged = true;
        console.log('[queue] Redis unavailable — using in-process fallback (messages still flow, no queue persistence).');
      }
    }
  }
  // Fire-and-forget: the webhook must not wait for the 3s debounce.
  // On Vercel, waitUntil() keeps the serverless function alive until
  // the in-process work finishes — an unowned promise would otherwise
  // be frozen/killed when the webhook response is sent and the AI reply
  // would silently vanish. Outside Vercel waitUntil() is a safe no-op
  // (the promise still runs, exactly as before).
  waitUntil(processInProcess(workspaceId, conversationId, text));
}
