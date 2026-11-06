import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';

export interface ScheduledPostJobData {
  postId: string;
  /** Workspace that owns the post; the worker falls back to a DB lookup if absent. */
  workspaceId?: string;
  runAt?: string;
}

// Same Redis-optional pattern as queue/client.ts: if Redis is down, BullMQ
// cannot queue, so enqueueScheduledPost logs once and the API relies on
// processDueScheduledPosts() polling instead. The connection never retries
// forever and never crashes the process.
const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
  retryStrategy: (times: number) => (times > 3 ? null : 200),
});
connection.on('error', () => {
  /* Redis down — enqueueScheduledPost() falls back to polling; logged once there. */
});

let redisDownLogged = false;

export const scheduledPostsQueue = new Queue<ScheduledPostJobData>('scheduled-posts', {
  connection,
});

/**
 * Enqueue a scheduled post for its publish time. Same jobId per post, so
 * re-scheduling a post replaces the pending job instead of double-posting.
 * If Redis is unavailable, logs once and returns — the worker / polling
 * sweep (processDueScheduledPosts) still publishes the post on time.
 */
export async function enqueueScheduledPost(
  postId: string,
  runAt: string | Date,
  workspaceId?: string,
): Promise<void> {
  const delay = Math.max(0, new Date(runAt).getTime() - Date.now());
  try {
    await Promise.race([
      scheduledPostsQueue.add(
        'publish',
        { postId, workspaceId, runAt: new Date(runAt).toISOString() },
        {
          jobId: `post-${postId}`,
          delay,
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
  } catch (err) {
    if (/already exists|duplicate/i.test((err as Error).message)) return;
    if (!redisDownLogged) {
      redisDownLogged = true;
      console.log(
        '[scheduled-posts queue] Redis unavailable — relying on processDueScheduledPosts polling (posts still publish, no queue persistence).',
      );
    }
  }
}
