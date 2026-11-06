/**
 * BullMQ queue definition for the AI Sales Inbox (Phase 1).
 *
 * The canonical queue client lives in the API package
 * (apps/api/src/queue/client.ts) so the API (webhook enqueue) and the worker
 * (job processing) share one queue, one job shape and one debounce rule.
 * This module re-exports it — there is exactly one 'inbox-messages' queue.
 */
export { enqueueMessage, getQueue, inboxQueue } from '../../../apps/api/src/queue/client';
export type { InboxJobData } from '../../../apps/api/src/queue/client';
