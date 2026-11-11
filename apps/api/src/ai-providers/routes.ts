import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { requireOwner } from '../owner/ownerAuth';
import {
  getAllProviderInfo,
  getProviderInfo,
  isAiProviderId,
  providerModels,
  providerWarningBn,
  resolveWorkspaceAi,
  systemDefaultAi,
  type AiProviderId,
} from '../ai-agent/providers';

/**
 * AI Providers settings — ALL FOUR providers listed (user decision,
 * 2026-11-11: Gemini, OpenAI, Claude, Groq). Gemini
 * (gemini-3.5-flash-lite) is the DEFAULT, not the only model.
 * - GET /api/ai-providers: all four providers with a live-probed
 *   status each (name, models, key present, can it reply right now,
 *   which one is the default), the workspace's current choice and
 *   the last 10 ledger rows. Probes are cached 5 minutes; pass
 *   ?refresh=1 to force a fresh live probe. Never probes on every
 *   page load beyond the cache.
 * - POST /api/ai-providers/select {provider, model?}: all four
 *   providers are accepted. If the selected provider cannot reply
 *   (no key / no credits / quota exhausted) the selection is STILL
 *   saved (the owner's choice) but the response carries a clear
 *   Bengali `warning` and `canReply: false` — the system never
 *   silently falls back to Gemini or pretends the model works.
 *   provider 'system' resets to the system default: it resolves
 *   (gemini / gemini-3.5-flash-lite) and WRITES it into the workspace
 *   columns. It never NULLs them — the old NULL reset silently left
 *   workspaces on the Groq env default, whose quota is exhausted, so
 *   live replies stopped (2026-11-07).
 * - POST /api/ai-providers/check-key {provider, apiKey}: probe with
 *   a key the owner just pasted (e.g. a Claude key). The key is
 *   NEVER stored, never cached, never logged, never echoed back —
 *   it only answers whether that key works right now. A key that
 *   works here still needs to be in the server settings
 *   (ANTHROPIC_API_KEY etc.) before live replies can use it.
 *   If the chosen provider itself fails at reply time the agent falls
 *   back to Groq internally (not offered anywhere — reliability net
 *   only, recorded honestly in the ledger as fallback_from). If Groq
 *   also fails, the chosen provider's real error is thrown so the
 *   agent records the true cause (see ai-agent/providers.ts).
 */
export const aiProvidersRouter = Router();
aiProvidersRouter.use(requireAuth);
// Task 14 — AI Provider settings are visible ONLY in the PLATFORM-owner
// account (requireOwner): shop owners AND workspace members get 403 on
// ALL endpoints. The sidebar hides the menu item too, but the API gate
// is the real enforcement.
//
// USER DECISION (2026-11-11, main chat ~18:48 + website side chat
// 18:47): "আমরা দেখাতে চাচ্ছি না কাস্টমারকে যে আমরা কোন মডেল ব্যবহার
// করতেছি" — the customer must never see which model answers them.
// Confirmed in the side chat: "AI Provider: shudhu tomar owner
// account-e thakbe — onno kono account-e dekhabe na" (only in the
// platform owner's account, in no other account). Do NOT revert this
// to requireWorkspaceOwner: a shop owner IS the customer here, and
// showing them the provider list (Gemini / Claude / Groq names +
// model ids) is exactly what the user forbade. The all-models listing
// still works — for the platform owner only.
aiProvidersRouter.use(requireOwner);

/** GET /api/ai-providers (?refresh=1 forces a fresh live probe) */
aiProvidersRouter.get('/ai-providers', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
  const providers = await getAllProviderInfo({ forceRefresh });
  const current = await resolveWorkspaceAi(workspaceId);
  const { rows: recent } = await query(
    workspaceId,
    `SELECT id, provider, model, input_tokens, output_tokens, cost_paisa,
            provider_cost_paisa, fallback_from, included_in_plan, created_at
     FROM ai_usage_ledger WHERE workspace_id = $1
     ORDER BY created_at DESC LIMIT 10`,
    [workspaceId],
  );
  res.json({
    providers,
    current,
    recentUsage: recent,
    defaultProvider: systemDefaultAi().provider,
    probedAt: new Date().toISOString(),
  });
});

/** POST /api/ai-providers/select */
aiProvidersRouter.post('/ai-providers/select', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { provider, model } = (req.body ?? {}) as { provider?: string; model?: string };

  // Reset to the system default: resolve the configured default
  // (gemini / gemini-3.5-flash-lite) and WRITE it into the columns.
  // The old code NULLed the columns here, which silently left the
  // workspace on the env default — Groq, whose free-tier quota is
  // exhausted — so live AI replies stopped and fell back to demo mode
  // (the 2026-11-07 provider-NULL reverts, 4 times). The columns
  // must never be NULLed by this path again.
  if (provider === 'system') {
    const def = systemDefaultAi();
    await query(
      workspaceId,
      'UPDATE workspaces SET ai_provider = $2, ai_model = $3, updated_at = now() WHERE id = $1',
      [workspaceId, def.provider, def.model],
    );
    const current = await resolveWorkspaceAi(workspaceId);
    res.json({ current, providers: await getAllProviderInfo(), reset: true });
    return;
  }

  if (!isAiProviderId(provider)) {
    res.status(400).json({ error: 'Unknown provider — use gemini, openai, claude or groq (or "system" to reset).' });
    return;
  }
  const resolvedModel = model?.trim() ? model.trim() : undefined;
  const models = providerModels(provider as AiProviderId);
  const chosenModel = resolvedModel ?? models[0];
  if (!models.includes(chosenModel)) {
    res.status(400).json({ error: `Unknown model for ${provider}: ${chosenModel}. Available: ${models.join(', ')}.` });
    return;
  }
  // Live-probe the chosen provider (cached ≤5 min, re-probed when
  // stale) so the warning below reflects reality, not a stale claim.
  const info = await getProviderInfo(provider as AiProviderId);
  const warning = providerWarningBn(info);
  // The owner's choice is saved even when the provider cannot reply
  // right now — but the warning travels with the response and the UI
  // shows it prominently, so nobody is left thinking it works.
  await query(
    workspaceId,
    'UPDATE workspaces SET ai_provider = $2, ai_model = $3, updated_at = now() WHERE id = $1',
    [workspaceId, provider, chosenModel],
  );
  const current = await resolveWorkspaceAi(workspaceId);
  res.json({
    current,
    providers: await getAllProviderInfo(),
    warning: warning ?? undefined,
    canReply: info.canReply,
    selectedStatus: info.status,
  });
});

/**
 * POST /api/ai-providers/check-key {provider, apiKey}
 * One-off probe with a key the owner pasted (the Claude card's key
 * input). The key is used for this single probe only: never stored,
 * never cached, never logged, never returned. The response says
 * whether the key works (`keyWorks`) and whether live replies can
 * actually use it (`replyReady` — true only when the server-env key
 * is also present, because the reply path reads the env key).
 */
aiProvidersRouter.post('/ai-providers/check-key', async (req: AuthRequest, res: Response) => {
  const { provider, apiKey } = (req.body ?? {}) as { provider?: string; apiKey?: string };
  if (!isAiProviderId(provider)) {
    res.status(400).json({ error: 'Unknown provider — use gemini, openai, claude or groq.' });
    return;
  }
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0 || apiKey.trim().length > 500) {
    res.status(400).json({ error: 'A key is required to check.' });
    return;
  }
  const probed = await getProviderInfo(provider as AiProviderId, {
    forceRefresh: true,
    apiKeyOverride: apiKey.trim(),
  });
  // The env-keyed status decides reply readiness: the reply path
  // (ai-agent/*.ts) reads the server-env key, not a pasted one.
  const envInfo = await getProviderInfo(provider as AiProviderId);
  const keyWorks = probed.status === 'connected';
  res.json({
    provider,
    keyWorks,
    status: probed.status,
    detail: probed.statusDetail,
    replyReady: keyWorks && envInfo.keyPresent,
    envVar: probed.envVar,
    note: keyWorks && !envInfo.keyPresent
      ? `চাবিটি কাজ করে, কিন্তু লাইভ উত্তরের জন্য চাবিটি সার্ভারের সেটিংসে (${probed.envVar}) বসাতে হবে।`
      : undefined,
  });
});
