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
// back to processing the message in-process (same 1s debounce, same agent).
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

// In-process fallback dedup: at most one scheduled/running fallback run
// per conversation in this process. A second enqueue while a run is
// scheduled or running is skipped — the scheduled run loads the full
// history from the DB, so rapid messages batch into ONE reply instead
// of producing one reply per message. (BullMQ's jobId dedup covers the
// Redis path; this covers the in-process fallback, which is what runs
// on Vercel where Redis is unavailable. The guard is per-process, so
// it only dedups within one warm serverless instance — cross-instance
// duplicates remain possible but rare, and the re-check loop below
// keeps a skipped message from being lost.)
const fallbackInFlight = new Set<string>();

async function processInProcess(
  workspaceId: string,
  conversationId: string,
  text?: string,
): Promise<void> {
  // Same 1s debounce as the BullMQ job: messages from the same customer
  // arriving within 1 second batch into one run, because the agent reloads
  // the full recent history from the DB when it runs.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  // A message can arrive while the agent is working (after the history
  // snapshot below). Loop so a message skipped by the dedup guard still
  // gets an answer: after each reply, check whether new inbound messages
  // arrived after the latest outgoing reply, and if so run again.
  // Bounded so a chatty customer cannot loop forever.
  for (let attempt = 0; attempt < 3; attempt++) {
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
      // Human mode / practice mode / no allowance: a re-run would not
      // reply either, so stop here.
      if (!result.replied) return;
      // Did a new inbound message arrive after our reply was saved?
      // (The reply is saved as an 'out' message, so anything 'in' after
      // the latest 'out' is unanswered.)
      const { rows: unanswered } = await query<{ n: string }>(
        workspaceId,
        `SELECT COUNT(*)::text AS n FROM messages
          WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'in'
            AND created_at > (SELECT MAX(created_at) FROM messages
             WHERE workspace_id = $1 AND conversation_id = $2 AND direction = 'out')`,
        [workspaceId, conversationId],
      );
      if (Number(unanswered[0]?.n ?? 0) === 0) return;
      console.log(`[queue:fallback] conv ${conversationId}: new message(s) arrived during the run — replying again (attempt ${attempt + 2})`);
    } catch (err) {
      console.error('[queue:fallback] in-process processing failed:', (err as Error).message);
      return;
    }
  }
}

/**
 * Enqueue a conversation for AI processing, debounced.
 * Same jobId per conversation + 1s delay: messages from the same customer
 * arriving within 1 second batch into one job, because the worker reloads
 * the full recent history from the DB when the job runs (so a duplicate
 * enqueue for an already-delayed job is safely ignored).
 *
 * The delay is 1s on purpose (was 3s): the customer must see the reply
 * within a few seconds of messaging, and the dedup guard + the re-check
 * loop below still keep rapid messages from producing duplicate replies.
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
            delay: 1000,
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
  // Fire-and-forget: the webhook must not wait for the 1s debounce.
  // On Vercel, waitUntil() keeps the serverless function alive until
  // the in-process work finishes — an unowned promise would otherwise
  // be frozen/killed when the webhook response is sent and the AI reply
  // would silently vanish. Outside Vercel waitUntil() is a safe no-op
  // (the promise still runs, exactly as before).
  //
  // Dedup: if a fallback run for this conversation is already scheduled
  // or running, skip this enqueue — that run loads the full history, so
  // it will answer this message too, and a second run would send a
  // duplicate reply. (A message that arrives while a run is working is
  // NOT lost: processInProcess re-checks for unanswered inbound
  // messages after each reply and runs again.)
  if (fallbackInFlight.has(conversationId)) {
    console.log(`[queue:fallback] conv ${conversationId}: fallback run already scheduled/running — skipping duplicate enqueue`);
    return;
  }
  fallbackInFlight.add(conversationId);
  waitUntil(
    processInProcess(workspaceId, conversationId, text).finally(() => {
      fallbackInFlight.delete(conversationId);
    }),
  );
}
