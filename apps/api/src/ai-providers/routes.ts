import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import {
  allProviderInfo,
  isAiProviderId,
  providerModels,
  resolveWorkspaceAi,
} from '../ai-agent/providers';

/**
 * AI Providers settings (multi-provider AI: Groq / OpenAI / Gemini / Claude).
 * - GET /api/ai-providers: every provider with status (connected /
 *   key_missing / blocked), cost note, the workspace's current choice and
 *   the last 10 ledger rows (provider, model, tokens, costs, fallback).
 * - POST /api/ai-providers/select {provider, model?}: pick the workspace's
 *   provider. A provider with no API key is NOT selectable as live (400).
 *   provider 'system' resets to the system default (NULL columns).
 *   Gemini has a key but is blocked (Google billing) — it CAN be chosen,
 *   but the response carries the warning and the agent falls back to Groq
 *   until billing is enabled.
 */
export const aiProvidersRouter = Router();
aiProvidersRouter.use(requireAuth);

const KEY_ENV: Record<string, string> = {
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
};

/** GET /api/ai-providers */
aiProvidersRouter.get('/ai-providers', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const providers = allProviderInfo();
  const current = await resolveWorkspaceAi(workspaceId);
  const { rows: recent } = await query(
    workspaceId,
    `SELECT id, provider, model, input_tokens, output_tokens, cost_paisa,
            provider_cost_paisa, fallback_from, included_in_plan, created_at
     FROM ai_usage_ledger WHERE workspace_id = $1
     ORDER BY created_at DESC LIMIT 10`,
    [workspaceId],
  );
  res.json({ providers, current, recentUsage: recent });
});

/** POST /api/ai-providers/select */
aiProvidersRouter.post('/ai-providers/select', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { provider, model } = (req.body ?? {}) as { provider?: string; model?: string };

  // Reset to the system default (env AI_PROVIDER).
  if (provider === 'system') {
    await query(
      workspaceId,
      'UPDATE workspaces SET ai_provider = NULL, ai_model = NULL, updated_at = now() WHERE id = $1',
      [workspaceId],
    );
    const current = await resolveWorkspaceAi(workspaceId);
    res.json({ current, providers: allProviderInfo(), reset: true });
    return;
  }

  if (!isAiProviderId(provider)) {
    res.status(400).json({ error: 'Unknown provider — use groq, openai, gemini or claude (or "system" to reset).' });
    return;
  }
  const info = allProviderInfo().find((p) => p.id === provider);
  if (!info) {
    res.status(400).json({ error: 'Unknown provider.' });
    return;
  }
  if (info.status === 'key_missing') {
    res.status(400).json({
      error: `${info.name} is not connected — ${KEY_ENV[provider]} is not set. Add the key first, then choose it.`,
    });
    return;
  }
  const resolvedModel = model?.trim() ? model.trim() : info.defaultModel;
  if (!providerModels(provider).includes(resolvedModel)) {
    res.status(400).json({ error: `Unknown model for ${info.name}: ${resolvedModel}` });
    return;
  }
  await query(
    workspaceId,
    'UPDATE workspaces SET ai_provider = $2, ai_model = $3, updated_at = now() WHERE id = $1',
    [workspaceId, provider, resolvedModel],
  );
  const current = await resolveWorkspaceAi(workspaceId);
  res.json({
    current,
    providers: allProviderInfo(),
    warning: info.status === 'blocked' ? info.blockedReason : undefined,
  });
});
