/**
 * Per-token AI rates (USD per 1M tokens) — verified 2026-11-06 from the
 * providers' official pricing pages (sources in the comments below),
 * except gpt-5-mini + gemini-3.5-flash, verified 2026-11-07 (see below).
 * gemini-3.5-flash was CORRECTED 2026-11-07: $1.50/$9.00 — the $0.30/
 * $2.50 it carried before was the gemini-3.5-flash-LITE rate, and it
 * under-reported every Gemini reply ~4x (e.g. 13 paisa recorded for a
 * reply that really cost ~57 paisa). These feed provider_cost_paisa in
 * the ledger ONLY: the WALLET charge stays the subscription rule
 * (included replies 0 paisa, overage flat 22 paisa). Override any rate
 * with AI_RATES_JSON env, e.g.
 * AI_RATES_JSON='{"gpt-5-mini":{"input":0.25,"output":2.00}}'.
 * Groq is 0: the platform uses Groq's FREE tier (30 req/min, 1,000
 * req/day); Groq's paid-tier rates do NOT apply while on the free tier.
 *
 * YEARBITO Phase 2: these rates feed provider_cost_paisa in the ledger
 * ONLY (transparency — what the reply really cost us). The WALLET
 * charge is the flat billing rule: included/package 0 paisa, old-plan
 * overage 22 paisa, pay-as-you-go 23 paisa per reply.
 */
import { config } from '../config';

export interface TokenRate {
  input: number;
  output: number;
  /**
   * Cached-input rate (USD per 1M tokens) for prompt-cache hits — only
   * set for models where context caching is priced (Gemini). Undefined
   * = no cached rate; cached tokens then cost the full input rate.
   */
  cached?: number;
}

const DEFAULT_RATES_USD_PER_MILLION: Record<string, TokenRate> = {
  // OpenAI — gpt-5-mini $0.25/$2.00 verified 2026-11-07 across
  // several sources citing OpenAI's pricing page (LiteLLM price file,
  // G2, getdeploying, requesty, wpwebhooks, apicost — all agree). The
  // old default gpt-6-luna does NOT exist (no gpt-6 in the key's
  // /v1/models list). gpt-5 $1.25/$10.00 and gpt-5-nano $0.05/$0.40
  // verified 2026-11-07 the same way (cabina, memetik, requesty, G2,
  // howmanytokens, apicost — all agree). gpt-4o-mini $0.15/$0.60 and
  // gpt-4o $2.50/$10.00 are corroborated by secondary sources citing
  // OpenAI's pricing page (not seen directly on the live page that day);
  // the same sources report both models are removed from the API on
  // 2027-01-14.
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  // Anthropic — platform.claude.com/docs/en/about-claude/pricing:
  // claude-sonnet-5-5 $2/$10; claude-haiku-5-5 $0.10/$0.50 for prompts
  // of 100,000 tokens or less ($0.50/$2.50 above — the ledger uses the
  // <=100K rate; shop prompts are far below that).
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  // Google — ai.google.dev/gemini-api/docs/pricing, verified 2026-11-07:
  // gemini-3.5-flash $1.50/$9.00 (CORRECTED — the $0.30/$2.50 it had
  // before was the Flash-Lite rate, not this model's). gemini-2.5-flash
  // $0.30/$2.50 (kept for old ledger rows). gemini-3.5-flash-lite
  // $0.30/$2.50. gemini-3-flash-preview (Gemini 3 Flash) $0.50/$3.00,
  // verified 2026-11-07 from Google's pricing page via secondary
  // sources (benchlm, puter, therundown — all agree).
  // Cached input (2026-11-11, same pricing page, Standard tier):
  // gemini-3.5-flash-lite cached input $0.03/1M (10x the $0.30 input
  // rate); cache storage $1.00/1M tokens/hour (charged on the Google
  // side, NOT in this per-reply cost — see gemini-cache.ts for the
  // break-even math that gates explicit-cache creation).
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-3.5-flash': { input: 1.5, output: 9 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cached: 0.03 },
  'gemini-3-flash-preview': { input: 0.5, output: 3 },
  // Groq free tier — 0. (Paid tier would be $0.075/$0.30, not used.)
  'openai/gpt-oss-20b': { input: 0, output: 0 },
  'openai/gpt-oss-120b': { input: 0, output: 0 },
  'qwen/qwen3.8-27b': { input: 0, output: 0 },
};

function rates(): Record<string, TokenRate> {
  const merged: Record<string, TokenRate> = { ...DEFAULT_RATES_USD_PER_MILLION };
  if (config.aiRatesJson.trim()) {
    try {
      const override = JSON.parse(config.aiRatesJson) as Record<string, Partial<TokenRate>>;
      for (const [model, r] of Object.entries(override)) {
        merged[model] = {
          input: r.input ?? merged[model]?.input ?? 0,
          output: r.output ?? merged[model]?.output ?? 0,
          cached: r.cached ?? merged[model]?.cached,
        };
      }
    } catch {
      console.error('[pricing] AI_RATES_JSON is not valid JSON — ignoring it');
    }
  }
  return merged;
}

export function tokenRateForModel(model: string): TokenRate {
  return rates()[model] ?? { input: 0, output: 0 };
}

/**
 * The provider's REAL cost of one reply, in paisa. Groq (free tier) and
 * the local demo mode are always 0. Unknown models cost 0 rather than
 * inventing a rate — the ledger never shows a made-up cost.
 *
 * cachedInputTokens (default 0) are the input tokens served from a
 * prompt cache (usageMetadata.cachedContentTokenCount): they are priced
 * at the model's cached-input rate ($0.03/1M for gemini-3.5-flash-lite)
 * instead of the full input rate — the rest of the input tokens pay the
 * full rate. Cached tokens are always a subset of inputTokens, so the
 * uncached part is (inputTokens - cachedInputTokens), clamped at 0.
 */
export function computeAiCostPaisa(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  if (provider === 'groq' || provider === 'demo') return 0;
  const rate = tokenRateForModel(model);
  const cached = Math.max(0, Math.min(cachedInputTokens, inputTokens));
  const cachedRate = rate.cached ?? rate.input;
  const usd =
    ((inputTokens - cached) / 1_000_000) * rate.input +
    (cached / 1_000_000) * cachedRate +
    (outputTokens / 1_000_000) * rate.output;
  return Math.round(usd * config.usdToBdtPaisa);
}
