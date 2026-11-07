/**
 * AI ON/OFF dot commands + mode switching — shared by the Inbox API
 * (apps/api/src/inbox/routes.ts) and the Meta webhook
 * (apps/api/src/webhooks/routes.ts) so the UI toggle and the Messenger
 * dot commands always write the same thing.
 *
 * The user asked for:
 *  - an AI উত্তর ON/OFF switch at the top of the Inbox conversation
 *    (ON = mode 'ai', the AI auto-replies; OFF = mode 'human', the
 *    owner replies himself);
 *  - dot commands inside Messenger: '.' toggles, '.on' turns the AI on,
 *    '.off' turns it off ('.ai on' / '.ai off' also work).
 *
 * Owner-only by design: a random customer typing '.' must NEVER toggle
 * anything. The webhook only accepts dot commands from (a) the sender
 * whose PSID the workspace marked as its owner (workspaces.owner_psid),
 * or (b) a message echo with no app_id — i.e. a human typing as the
 * Page in Page Inbox (an echo proves the sender IS the Page; our own
 * app's sends carry our app_id and are never acted on).
 *
 * A toggle (UI switch or dot command) always cancels a pending timed
 * handover: applyAiMode clears handover_until, so the auto-return sweep
 * can never flip the mode back after the owner chose otherwise.
 */
import { query, queryOne } from '../db/pool';
import { deliverOutgoingMessage } from '../channels/meta-send';

export type DotCommand = 'toggle' | 'on' | 'off';

/**
 * Parse a Messenger text into a dot command, or null when it is not one.
 * Only the exact commands match — a normal message that merely starts
 * with a dot (e.g. ".5" or "..") is NOT a command.
 */
export function parseDotCommand(raw: string | null | undefined): DotCommand | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if (text === '.') return 'toggle';
  if (text === '.on' || text === '.ai on' || text === '.ai-on') return 'on';
  if (text === '.off' || text === '.ai off' || text === '.ai-off') return 'off';
  return null;
}

/** Short confirmation the Page sends into the chat after a dot toggle. */
export const MODE_CONFIRMATIONS = {
  ai: 'AI উত্তর চালু হয়েছে — এখন থেকে AI নিজে উত্তর দেবে।',
  human: 'AI উত্তর বন্ধ হয়েছে — এখন আপনি নিজে উত্তর দিন।',
} as const;

/**
 * Set a conversation's AI mode. Always cancels a pending timed handover
 * (handover_until cleared, handed_to follows the mode), so a manual
 * toggle can never be undone by the auto-return sweep. Returns the new
 * mode, or null when the conversation does not exist in this workspace.
 */
export async function applyAiMode(
  workspaceId: string,
  conversationId: string,
  mode: 'ai' | 'human',
): Promise<'ai' | 'human' | null> {
  const { rows } = await query<{ mode: string }>(
    workspaceId,
    `UPDATE conversations
     SET mode = $1, handed_to = $1, handover_until = NULL, updated_at = now()
     WHERE workspace_id = $2 AND id = $3 RETURNING mode`,
    [mode, workspaceId, conversationId],
  );
  const next = rows[0]?.mode;
  return next === 'ai' || next === 'human' ? next : null;
}

/** Flip a conversation between 'ai' and 'human'. Returns the new mode. */
export async function toggleAiMode(
  workspaceId: string,
  conversationId: string,
): Promise<'ai' | 'human' | null> {
  const current = await queryOne<{ mode: string }>(
    workspaceId,
    'SELECT mode FROM conversations WHERE workspace_id = $1 AND id = $2',
    [workspaceId, conversationId],
  );
  if (!current) return null;
  return applyAiMode(workspaceId, conversationId, current.mode === 'ai' ? 'human' : 'ai');
}

/** Apply a parsed dot command. Returns the new mode, or null if unknown. */
export async function applyDotCommand(
  workspaceId: string,
  conversationId: string,
  cmd: DotCommand,
): Promise<'ai' | 'human' | null> {
  if (cmd === 'toggle') return toggleAiMode(workspaceId, conversationId);
  return applyAiMode(workspaceId, conversationId, cmd === 'on' ? 'ai' : 'human');
}

/**
 * Workspace-level AI switch — the owner's global toggle from Messenger.
 * When the owner messages "." from his personal account there is NO
 * conversation to toggle (his messages must never create a customer or
 * conversation — that is how a chat opened in the name "ইয়াসিন
 * আরাফাত"), so the command flips workspaces.ai_enabled for the whole
 * shop instead. processBatch already stops all AI replies when
 * ai_enabled is false. Returns the new state, or null when the
 * workspace does not exist.
 */
export async function setWorkspaceAiMode(workspaceId: string, enabled: boolean): Promise<boolean | null> {
  const { rows } = await query<{ ai_enabled: boolean }>(
    workspaceId,
    'UPDATE workspaces SET ai_enabled = $1, updated_at = now() WHERE id = $2 RETURNING ai_enabled',
    [enabled, workspaceId],
  );
  return rows[0] ? Boolean(rows[0].ai_enabled) : null;
}

/** Flip the workspace-level AI switch. Returns the new state. */
export async function toggleWorkspaceAiMode(workspaceId: string): Promise<boolean | null> {
  const row = await queryOne<{ ai_enabled: boolean }>(
    workspaceId,
    'SELECT ai_enabled FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!row) return null;
  return setWorkspaceAiMode(workspaceId, !row.ai_enabled);
}

/**
 * Send the short mode confirmation into the chat as the Page. Best
 * effort: a failed send (e.g. the 24h window closed) is logged, never
 * thrown — the toggle itself already happened.
 */
export async function sendModeConfirmation(
  workspaceId: string,
  conversationId: string,
  mode: 'ai' | 'human',
): Promise<void> {
  try {
    const result = await deliverOutgoingMessage(workspaceId, conversationId, MODE_CONFIRMATIONS[mode]);
    if (!result.sent) {
      console.error('[dot-commands] confirmation not delivered:', result.error ?? 'unknown');
    }
  } catch (err) {
    console.error('[dot-commands] confirmation send failed:', (err as Error).message);
  }
}

/** The PSID the workspace marked as its owner, or null when none is marked. */
export async function getWorkspaceOwnerPsid(workspaceId: string): Promise<string | null> {
  const row = await queryOne<{ owner_psid: string | null }>(
    workspaceId,
    'SELECT owner_psid FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  return row?.owner_psid ?? null;
}
