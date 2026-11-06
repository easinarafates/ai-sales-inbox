/**
 * Per-token AI rates (USD per 1M tokens) — verified 2026-11-06 from the
 * providers' official pricing pages (sources in the comments below).
 * These feed provider_cost_paisa in the ledger ONLY: the WALLET charge
 * stays the subscription rule (included replies 0 paisa, overage flat
 * 10 paisa). Override any rate with AI_RATES_JSON env, e.g.
 * AI_RATES_JSON='{"gpt-6-luna":{"input":0.10,"output":0.50}}'.
 * Groq is 0: the platform uses Groq's FREE tier (30 req/min, 1,000
 * req/day); Groq's paid-tier rates do NOT apply while on the free tier.
 */
import { config } from '../config';

export interface TokenRate {
  input: number;
  output: number;
}

const DEFAULT_RATES_USD_PER_MILLION: Record<string, TokenRate> = {
  // OpenAI — gpt-6-luna $0.10/$0.50 verified on
  // developers.openai.com/api/docs/pricing (2026-11-06). gpt-4o-mini
  // $0.15/$0.60 and gpt-4o $2.50/$10.00 are corroborated by secondary
  // sources citing OpenAI's pricing page (not seen directly on the live
  // page that day); the same sources report both models are removed from
  // the API on 2027-01-14.
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  // Anthropic — platform.claude.com/docs/en/about-claude/pricing:
  // claude-sonnet-5-5 $2/$10; claude-haiku-5-5 $0.10/$0.50 for prompts
  // of 100,000 tokens or less ($0.50/$2.50 above — the ledger uses the
  // <=100K rate; shop prompts are far below that).
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  // Google — ai.google.dev/gemini-api/docs/pricing: gemini-2.5-flash
  // $0.30/$2.50. Deprecated: from 2026-12-01 requests auto-route to
  // gemini-3.5-flash-lite (its rates were not verified; secondary sources
  // say the same $0.30/$2.50).
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
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
 */
export function computeAiCostPaisa(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (provider === 'groq' || provider === 'demo') return 0;
  const rate = tokenRateForModel(model);
  const usd = (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
  return Math.round(usd * config.usdToBdtPaisa);
}
