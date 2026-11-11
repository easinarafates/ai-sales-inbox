/**
 * Unified AI provider interface — ALL FOUR providers listed (user
 * decision, 2026-11-11 18:43: every model in the owner-only AI Provider
 * settings — Gemini, OpenAI, Claude, Groq). This RESTORES the
 * 2026-11-06/07 model selector that the YEARBITO build narrowed to
 * Gemini-only. "Gemini final" means Gemini is the DEFAULT model
 * (systemDefaultAi / gemini-3.5-flash-lite), NOT the only listed model.
 *
 * What this means in code:
 * - getAllProviderInfo() returns all four providers with an HONEST,
 *   live-probed status each: a tiny probe call (a few tokens at most;
 *   a failed call is not billed) decides whether the provider can
 *   actually reply right now. Probes are cached 5 minutes and only
 *   re-run on demand (?refresh=1) or when stale — never on every page
 *   load. No status is hardcoded: the same provider reports a
 *   different status when its probe outcome changes (e.g. a mocked
 *   OpenAI probes as connected, the real key probes as no_credits).
 *   Claude with no key is NEVER probed and never asked for.
 * - resolveWorkspaceAi() honours the workspace's stored choice
 *   (ai_provider / ai_model columns) — any of the four providers.
 *   An invalid / NULL stored choice resolves to the Gemini default.
 * - The Groq fallback in callAiForWorkspace STAYS: it is not offered
 *   as a selectable model — it is only an internal reliability net so
 *   a customer still gets an answer when the chosen provider fails.
 *   The fallback is recorded in the ledger (fallbackFrom) and logged
 *   — never silent, never passed off as the chosen provider. It NEVER
 *   falls back TO Gemini: the fallback target is always Groq.
 * - NEW (2026-11-11): when the chosen provider ERRORS and the Groq
 *   backup also fails, callAiForWorkspace/Split THROW the chosen
 *   provider's real error instead of returning null. agent.ts catches
 *   it, records the real cause in its ticket, and uses the labelled
 *   demo mode. Returning null used to lose the cause — the ticket
 *   then wrongly said "API key not configured" for a 429 no-credits
 *   failure. A provider with no key at all (callProvider returns
 *   null, not an error) still returns null — the agent's "API key
 *   not configured" ticket is already accurate for that case.
 *
 * The deprecated nano model is NOT listed anywhere: it is deprecated
 * and shuts down 11 Dec 2026. OpenAI offers gpt-5-mini (default) and
 * gpt-5 only.
 *
 * Every provider call returns the same contract the sales agent uses:
 * { text, inputTokens, outputTokens } where text is a Bengali JSON reply
 * ({"reply", "confidence", "toolCalls"}). Prices/stock still come ONLY
 * from the products table via tools — the provider never invents them.
 *
 * Rules:
 * - A provider with no API key returns null (never a fake reply).
 * - Test-only mocks (AI_MOCK_PROVIDERS env, e.g. "gemini") make a
 *   provider answer with a canned deterministic reply WITHOUT calling the
 *   real API, so the verifier can test dispatch/fallback/cost math
 *   without spending money or needing a key. OFF by default.
 */
import { config } from '../config';
import { queryOne } from '../db/pool';
import { fetchWithTimeout } from './http';
import { callGemini, callGeminiWithCache, type GeminiResult } from './gemini';
import { callGroq } from './groq';
import { callOpenAI } from './openai';
import { callClaude } from './claude';

export type AiProviderId = 'groq' | 'openai' | 'gemini' | 'claude';

export const AI_PROVIDERS: AiProviderId[] = ['groq', 'openai', 'gemini', 'claude'];

/** Display order on the settings page — the default first. */
export const AI_PROVIDER_DISPLAY_ORDER: AiProviderId[] = ['gemini', 'openai', 'claude', 'groq'];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDERS as string[]).includes(value);
}

export interface AiCallOutcome extends GeminiResult {
  provider: AiProviderId;
  model: string;
  /** The provider the workspace chose, when Groq served the reply instead. */
  fallbackFrom?: AiProviderId | null;
}

/**
 * Live status of one provider:
 * - connected: the probe just answered — it can reply right now.
 * - key_missing: no API key is set (Claude today) — never probed.
 * - no_credits: key present, but the account has no credits left
 *   (OpenAI 429 insufficient_quota) — cannot reply.
 * - quota_exhausted: the free-tier / rate quota is used up (Groq 429)
 *   — cannot reply right now.
 * - blocked: the key/account is rejected (401/403) or another API
 *   error — cannot reply.
 * - unknown: the probe itself could not run (network / 5xx / timeout)
 *   — reply ability is unproven, not claimed either way.
 */
export type AiProviderStatus =
  | 'connected'
  | 'key_missing'
  | 'no_credits'
  | 'quota_exhausted'
  | 'blocked'
  | 'unknown';

export interface AiProviderInfo {
  id: AiProviderId;
  name: string;
  models: string[];
  defaultModel: string;
  status: AiProviderStatus;
  blockedReason?: string | null;
  /** Test-only mock is active for this provider (no real API call made). */
  mock?: boolean;
  /** Human-readable cost note (Bengali) for the settings page. */
  costNote: string;
  /** An API key is present (server env). Never the key itself. */
  keyPresent: boolean;
  /** The server env var that holds this provider's key. */
  envVar: string;
  /** True only when the live probe just proved it can reply. */
  canReply: boolean;
  /** True for the system default provider (Gemini) — never moves. */
  isDefault: boolean;
  /** Bengali human-readable reason for the status (null when connected). */
  statusDetail: string | null;
  /** How this status was decided: live probe / cached probe / key only / mock. */
  probe: 'live' | 'cached' | 'key_only' | 'mock';
  /** ISO time of the last live probe (null when never probed). */
  checkedAt: string | null;
}

/** Canned reply used ONLY by the test mock (never a live answer).
 * Token counts (20,000 in / 10,000 out) are deliberately large so the
 * verifier can assert cost math exactly: gpt-5-mini $0.25/$2.00 gives
 * (0.02 x 0.25 + 0.01 x 2.00) x 12200 = 305 paisa; claude-sonnet-5-5
 * $2/$10 gives (0.02 x 2 + 0.01 x 10) x 12200 = 1708 paisa. */
const MOCK_REPLY =
  '{"reply": "দাম জানতে চেয়েছেন — প্রোডাক্টের দাম টুল থেকে দেখে জানাচ্ছি।", "confidence": 0.9, "toolCalls": []}';

function mockProviders(): Set<string> {
  return new Set(
    config.aiMockProviders
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isMockProvider(provider: AiProviderId): boolean {
  return mockProviders().has(provider);
}

function mockResult(provider: AiProviderId, model: string): AiCallOutcome {
  return { text: MOCK_REPLY, inputTokens: 20000, outputTokens: 10000, cachedInputTokens: 0, provider, model };
}

/** Model lists (defaults come from config — never hardcoded elsewhere). */
export function providerModels(provider: AiProviderId): string[] {
  const unique = (...models: string[]): string[] => [...new Set(models)];
  switch (provider) {
    case 'groq':
      return unique(config.groqModel, 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b');
    case 'openai':
      // gpt-5-mini (default) and gpt-5 only. The deprecated nano model
      // is deliberately NOT listed (shuts down 11 Dec 2026), and the
      // older 4o models are not offered either.
      return unique(config.openaiModel, 'gpt-5-mini', 'gpt-5');
    case 'gemini':
      // Gemini final (user decision 2026-11-11): gemini-3.5-flash-lite
      // is the default model — no other Gemini model is listed.
      return ['gemini-3.5-flash-lite'];
    case 'claude':
      return unique(config.claudeModel, 'claude-haiku-5-5');
  }
}

export function providerDefaultModel(provider: AiProviderId): string {
  return providerModels(provider)[0];
}

function providerName(provider: AiProviderId): string {
  switch (provider) {
    case 'groq':
      return 'Groq';
    case 'openai':
      return 'OpenAI';
    case 'gemini':
      return 'Gemini (Google)';
    case 'claude':
      return 'Claude (Anthropic)';
  }
}

function providerEnvVar(provider: AiProviderId): string {
  switch (provider) {
    case 'groq':
      return 'GROQ_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'gemini':
      return 'GEMINI_API_KEY';
    case 'claude':
      return 'ANTHROPIC_API_KEY';
  }
}

function providerCostNote(provider: AiProviderId): string {
  switch (provider) {
    case 'groq':
      return 'ফ্রি — প্রতি রিপ্লাই ৳০ (ফ্রি টিয়ার: দিনে ১,০০০ উত্তর)';
    case 'openai':
      return 'পেইড — টোকেন হিসেবে খরচ (gpt-5-mini: $0.25 / $2.00 প্রতি ১০ লাখ টোকেন)';
    case 'gemini':
      return 'পেইড — Gemini Lite (gemini-3.5-flash-lite); শপের দাম: প্যাকেজ ২২ পয়সা/রিপ্লাই, pay-as-you-go ২৩ পয়সা/রিপ্লাই';
    case 'claude':
      return 'পেইড — টোকেন হিসেবে খরচ (Claude Sonnet 5.5: $2 / $10 প্রতি ১০ লাখ টোকেন)';
  }
}

/** The server-env key for a provider ('' when unset — never logged). */
export function providerEnvKey(provider: AiProviderId): string {
  switch (provider) {
    case 'groq':
      return config.groqApiKey;
    case 'openai':
      return config.openaiApiKey;
    case 'gemini':
      return config.geminiApiKey;
    case 'claude':
      return config.anthropicApiKey;
  }
}

function providerKeyPresent(provider: AiProviderId): boolean {
  return providerEnvKey(provider).length > 0;
}

/**
 * Bengali reason shown next to a non-connected status. `null` when the
 * provider is connected (nothing to explain).
 */
export function providerStatusDetail(provider: AiProviderId, status: AiProviderStatus): string | null {
  switch (status) {
    case 'connected':
      return null;
    case 'key_missing':
      return 'API চাবি বসানো হয়নি, তাই এটা এখনো উত্তর দিতে পারবে না।';
    case 'no_credits':
      return 'চাবি আছে, কিন্তু অ্যাকাউন্টে ক্রেডিট নেই — উত্তর দিতে পারবে না।';
    case 'quota_exhausted':
      return 'ফ্রি লিমিট শেষ হয়ে গেছে — এখন উত্তর দিতে পারবে না।';
    case 'blocked':
      return 'চাবি বা অ্যাকাউন্টে সমস্যা আছে — উত্তর দিতে পারবে না।';
    case 'unknown':
      return 'এই মুহূর্তে যাচাই করা যায়নি — একটু পরে আবার দেখুন।';
  }
}

/**
 * The warning the settings page (and the select response) shows when
 * the owner picks a provider that cannot reply right now. `null` when
 * the provider can reply. The selection is still saved — the owner's
 * choice — but nobody is left thinking it works.
 */
export function providerWarningBn(info: AiProviderInfo): string | null {
  if (info.canReply) return null;
  switch (info.status) {
    case 'key_missing':
      return `${info.name}-এর চাবি দেওয়া হয়নি — সিলেক্ট করলে AI উত্তর দিতে পারবে না।`;
    case 'no_credits':
      return `${info.name}-এর ক্রেডিট নেই — সিলেক্ট করলে AI উত্তর দিতে পারবে না।`;
    case 'quota_exhausted':
      return `${info.name}-এর ফ্রি লিমিট শেষ — সিলেক্ট করলে AI উত্তর দিতে পারবে না।`;
    case 'blocked':
      return `${info.name}-এর চাবি বা অ্যাকাউন্টে সমস্যা আছে — সিলেক্ট করলে AI উত্তর দিতে পারবে না।`;
    case 'unknown':
      return `${info.name} এখন যাচাই করা যায়নি — সিলেক্ট করলে AI উত্তর নাও দিতে পারে।`;
    case 'connected':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Live probes — a REAL lightweight check per provider, cached 5 minutes.
// ---------------------------------------------------------------------------

/** Probe results are cached this long; a fresh probe runs only when the
 * cache is stale or the caller forces a refresh (?refresh=1). */
export const PROVIDER_PROBE_CACHE_TTL_MS = 5 * 60 * 1000;

interface ProbeCacheEntry {
  status: AiProviderStatus;
  detail: string | null;
  at: number;
}

const probeCache = new Map<AiProviderId, ProbeCacheEntry>();

/** Test helper: drop all cached probe results so the next read re-probes. */
export function clearProviderProbeCache(): void {
  probeCache.clear();
}

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_PROMPT = 'Reply with exactly the word ok.';

/** Map a failed probe HTTP response to an honest status. */
function classifyProbeFailure(
  provider: AiProviderId,
  httpStatus: number,
  bodyText: string,
): { status: AiProviderStatus; detail: string | null } {
  const lower = bodyText.toLowerCase();
  if (httpStatus === 429) {
    // OpenAI bills nothing on a failed call: a 429 that says the
    // account has no credits proves "key present, no credits".
    if (/insufficient_quota|no credits|billing/i.test(bodyText)) {
      const status: AiProviderStatus = 'no_credits';
      return { status, detail: providerStatusDetail(provider, status) };
    }
    const status: AiProviderStatus = 'quota_exhausted';
    return { status, detail: providerStatusDetail(provider, status) };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    const status: AiProviderStatus = 'blocked';
    return { status, detail: providerStatusDetail(provider, status) };
  }
  if (httpStatus >= 500) {
    const status: AiProviderStatus = 'unknown';
    return { status, detail: providerStatusDetail(provider, status) };
  }
  const status: AiProviderStatus = 'blocked';
  return { status, detail: providerStatusDetail(provider, status) };
}

function classifyProbeNetworkError(provider: AiProviderId, err: Error): { status: AiProviderStatus; detail: string | null } {
  void err;
  const status: AiProviderStatus = 'unknown';
  return { status, detail: providerStatusDetail(provider, status) };
}

/**
 * One tiny probe call against the provider's real API. A success costs
 * only a handful of tokens (a few words in, a few out); a failure costs
 * nothing (failed calls are not billed). `apiKeyOverride` probes with a
 * key the owner just pasted (key-check endpoint) — it is never stored,
 * never cached, never logged. With no key at all there is no probe:
 * Claude without a key reports key_missing without any network call.
 */
async function runProbe(
  provider: AiProviderId,
  apiKeyOverride?: string,
): Promise<{ status: AiProviderStatus; detail: string | null }> {
  const key = apiKeyOverride ?? providerEnvKey(provider);
  if (!key) {
    const status: AiProviderStatus = 'key_missing';
    return { status, detail: providerStatusDetail(provider, status) };
  }
  try {
    let res: Response;
    if (provider === 'gemini') {
      res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${providerDefaultModel('gemini')}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: PROBE_PROMPT }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 4 },
          }),
        },
        PROBE_TIMEOUT_MS,
      );
    } else if (provider === 'openai') {
      res = await fetchWithTimeout(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          // gpt-5 models only accept the default temperature — omit it.
          body: JSON.stringify({
            model: providerDefaultModel('openai'),
            messages: [{ role: 'user', content: PROBE_PROMPT }],
            max_completion_tokens: 4,
          }),
        },
        PROBE_TIMEOUT_MS,
      );
    } else if (provider === 'groq') {
      res = await fetchWithTimeout(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: providerDefaultModel('groq'),
            messages: [{ role: 'user', content: PROBE_PROMPT }],
            max_tokens: 4,
          }),
        },
        PROBE_TIMEOUT_MS,
      );
    } else {
      res = await fetchWithTimeout(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            'x-api-key': key,
            'anthropic-version': '2026-10-21',
          },
          body: JSON.stringify({
            model: providerDefaultModel('claude'),
            max_tokens: 4,
            system: 'Reply with exactly the word ok.',
            messages: [{ role: 'user', content: PROBE_PROMPT }],
          }),
        },
        PROBE_TIMEOUT_MS,
      );
    }
    if (res.ok) {
      // Drain the body so the connection can be reused; the content
      // does not matter — an HTTP 200 IS the proof it can reply.
      await res.text().catch(() => '');
      return { status: 'connected', detail: null };
    }
    const bodyText = await res.text().catch(() => '');
    return classifyProbeFailure(provider, res.status, bodyText.slice(0, 500));
  } catch (err) {
    return classifyProbeNetworkError(provider, err as Error);
  }
}

export interface ProbeOptions {
  /** Ignore the cache and probe live right now. */
  forceRefresh?: boolean;
  /** Probe with this key instead of the server-env key (never cached). */
  apiKeyOverride?: string;
}

/**
 * The live status of one provider, from the real probe path (cached up
 * to 5 minutes unless forced). A mocked provider reports connected
 * without any network call. Returns the status + Bengali detail +
 * whether the value came from a live probe, the cache, or the mock.
 */
export async function probeProviderStatus(
  provider: AiProviderId,
  opts: ProbeOptions = {},
): Promise<{ status: AiProviderStatus; detail: string | null; probe: 'live' | 'cached' | 'mock'; checkedAt: string }> {
  if (isMockProvider(provider) && !opts.apiKeyOverride) {
    return { status: 'connected', detail: null, probe: 'mock', checkedAt: new Date().toISOString() };
  }
  if (opts.apiKeyOverride) {
    const live = await runProbe(provider, opts.apiKeyOverride);
    return { ...live, probe: 'live', checkedAt: new Date().toISOString() };
  }
  const cached = probeCache.get(provider);
  if (!opts.forceRefresh && cached && Date.now() - cached.at < PROVIDER_PROBE_CACHE_TTL_MS) {
    return { status: cached.status, detail: cached.detail, probe: 'cached', checkedAt: new Date(cached.at).toISOString() };
  }
  const live = await runProbe(provider);
  probeCache.set(provider, { status: live.status, detail: live.detail, at: Date.now() });
  return { ...live, probe: 'live', checkedAt: new Date().toISOString() };
}

function buildProviderInfo(
  provider: AiProviderId,
  status: AiProviderStatus,
  detail: string | null,
  probe: 'live' | 'cached' | 'key_only' | 'mock',
  checkedAt: string | null,
): AiProviderInfo {
  const isDefault = provider === systemDefaultAi().provider;
  return {
    id: provider,
    name: providerName(provider),
    models: providerModels(provider),
    defaultModel: providerDefaultModel(provider),
    status,
    blockedReason: status === 'connected' ? null : detail,
    mock: isMockProvider(provider) || undefined,
    costNote: providerCostNote(provider),
    keyPresent: providerKeyPresent(provider),
    envVar: providerEnvVar(provider),
    canReply: status === 'connected',
    isDefault,
    statusDetail: detail,
    probe,
    checkedAt,
  };
}

/**
 * Full info for one provider, with the live-probed status. `probe` says
 * how the status was decided — 'live' (just probed), 'cached' (probe
 * from the last 5 minutes), 'mock' (test mock), never a hardcoded claim.
 */
export async function getProviderInfo(provider: AiProviderId, opts: ProbeOptions = {}): Promise<AiProviderInfo> {
  const probed = await probeProviderStatus(provider, opts);
  return buildProviderInfo(provider, probed.status, probed.detail, probed.probe, probed.checkedAt);
}

/**
 * All four providers, display order (Gemini first — it is the
 * default), each with its live-probed status. Probes run in parallel;
 * a single provider's probe failure never blocks the others.
 */
export async function getAllProviderInfo(opts: ProbeOptions = {}): Promise<AiProviderInfo[]> {
  const settled = await Promise.allSettled(
    AI_PROVIDER_DISPLAY_ORDER.map((p) => getProviderInfo(p, opts)),
  );
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const provider = AI_PROVIDER_DISPLAY_ORDER[i];
    return buildProviderInfo(provider, 'unknown', providerStatusDetail(provider, 'unknown'), 'key_only', null);
  });
}

/**
 * Key-only info for one provider (no network): 'connected' when a key
 * (or mock) is present, 'key_missing' otherwise. Used only where an
 * async probe is impossible — the settings API always uses the probed
 * getProviderInfo/getAllProviderInfo above, so what the owner sees is
 * probe-backed. `canReply` here means "a key exists", NOT "proven to
 * reply" — the probe field says so (key_only).
 */
export function providerInfo(provider: AiProviderId): AiProviderInfo {
  const mock = isMockProvider(provider);
  const keyPresent = providerKeyPresent(provider);
  const status: AiProviderStatus = mock || keyPresent ? 'connected' : 'key_missing';
  return buildProviderInfo(
    provider,
    status,
    status === 'connected' ? null : providerStatusDetail(provider, status),
    'key_only',
    null,
  );
}

/**
 * The providers OFFERED to the shop — ALL FOUR (user decision,
 * 2026-11-11). Key-only statuses (see providerInfo); the settings API
 * uses the probed getAllProviderInfo instead.
 */
export function allProviderInfo(): AiProviderInfo[] {
  return AI_PROVIDER_DISPLAY_ORDER.map((p) => providerInfo(p));
}

/**
 * Call one provider directly. Returns null when it is not configured
 * (no key and no mock); throws on API errors so the caller can fall back.
 */
export async function callProvider(
  provider: AiProviderId,
  prompt: string,
  model?: string,
): Promise<AiCallOutcome | null> {
  const resolvedModel = model ?? providerDefaultModel(provider);
  if (isMockProvider(provider)) return mockResult(provider, resolvedModel);
  let result: GeminiResult | null;
  switch (provider) {
    case 'groq':
      result = await callGroq(prompt, resolvedModel);
      break;
    case 'openai':
      result = await callOpenAI(prompt, resolvedModel);
      break;
    case 'gemini':
      result = await callGemini(prompt, resolvedModel);
      break;
    case 'claude':
      result = await callClaude(prompt, resolvedModel);
      break;
  }
  return result ? { ...result, provider, model: resolvedModel } : null;
}

export interface WorkspaceAiChoice {
  provider: AiProviderId;
  model: string;
  /** True when the owner picked this explicitly; false = system default. */
  explicit: boolean;
}

/**
 * The platform's system default AI — what "Use system default"
 * resolves to. Gemini final (user decision 2026-11-11): ALWAYS
 * gemini / gemini-3.5-flash-lite, regardless of env (AI_PROVIDER /
 * AI_MODEL no longer select a model). It NEVER returns NULL and NEVER
 * resolves to Groq: Groq's free-tier quota is exhausted, so a
 * workspace left on the Groq default silently stops getting live
 * replies (the 2026-11-07 provider-NULL reverts). Callers that apply
 * this default WRITE these concrete values into the workspace columns
 * instead of NULLing them.
 */
export function systemDefaultAi(): { provider: AiProviderId; model: string } {
  return { provider: 'gemini', model: 'gemini-3.5-flash-lite' };
}

/**
 * The workspace's AI choice — the stored ai_provider / ai_model
 * columns when they name a real provider + model (any of the four),
 * else the Gemini system default. Pass the already-loaded workspace
 * row when the caller has it, to avoid a second query (agent.ts does).
 *
 * `explicit` is false whenever the resolved choice IS the system
 * default — a stored gemini/lite is the default, not a distinct pick,
 * so the Settings page correctly reads "System default". Any other
 * valid stored choice is explicit: the owner picked it.
 */
export async function resolveWorkspaceAi(
  workspaceId: string,
  preloaded?: { ai_provider?: string | null; ai_model?: string | null },
): Promise<WorkspaceAiChoice> {
  const def = systemDefaultAi();
  let stored = preloaded;
  if (!stored) {
    try {
      stored =
        (await queryOne<{ ai_provider: string | null; ai_model: string | null }>(
          workspaceId,
          'SELECT ai_provider, ai_model FROM workspaces WHERE id = $1',
          [workspaceId],
        )) ?? undefined;
    } catch {
      stored = undefined;
    }
  }
  const p = stored?.ai_provider ?? null;
  const m = stored?.ai_model ?? null;
  if (isAiProviderId(p) && typeof m === 'string' && providerModels(p).includes(m)) {
    return { provider: p, model: m, explicit: !(p === def.provider && m === def.model) };
  }
  return { provider: def.provider, model: def.model, explicit: false };
}

/**
 * The agent's entry point: call the workspace's chosen provider, and on
 * any failure (no key, or an API error like insufficient credits) fall
 * back to Groq. The outcome names the provider that ACTUALLY answered
 * and, when it was a fallback, which provider was chosen (fallbackFrom)
 * — the ledger records both, so a fallback is never passed off as the
 * chosen provider.
 *
 * Honest failure: if the chosen provider ERRORED and the Groq backup
 * also failed, this THROWS the chosen provider's real error instead of
 * returning null, so agent.ts records the real cause in its ticket and
 * uses the labelled demo mode (a null here used to make the ticket
 * wrongly say "API key not configured"). The Groq fallback itself is
 * NOT removed — it is still attempted first. There is NEVER a silent
 * fallback TO Gemini: the fallback target is always Groq.
 * Returns null only when the chosen provider has no key at all (then
 * the agent's "API key not configured" ticket is already accurate).
 */
export async function callAiForWorkspace(
  workspaceId: string,
  prompt: string,
  choice?: WorkspaceAiChoice,
): Promise<AiCallOutcome | null> {
  const resolved = choice ?? (await resolveWorkspaceAi(workspaceId));
  let selectedError: Error | null = null;
  try {
    const result = await callProvider(resolved.provider, prompt, resolved.model);
    if (result) return result;
    console.error(
      `[ai] provider ${resolved.provider} not configured (no key) — falling back to groq`,
    );
  } catch (err) {
    selectedError = err as Error;
    console.error(
      `[ai] provider ${resolved.provider} failed (${selectedError.message}) — falling back to groq`,
    );
  }
  if (resolved.provider !== 'groq') {
    try {
      const fallback = await callProvider('groq', prompt);
      if (fallback) return { ...fallback, fallbackFrom: resolved.provider };
    } catch (err) {
      console.error(`[ai] groq fallback also failed: ${(err as Error).message}`);
    }
  }
  // Nothing answered. An errored chosen provider must surface its real
  // cause (no credits / quota / billing) — never a silent null that the
  // agent then mis-reports as "no key". A keyless provider returns null.
  if (selectedError) {
    throw new Error(
      `${resolved.provider} failed: ${selectedError.message} (backup Groq also failed)`,
    );
  }
  return null;
}

/**
 * Split-prompt call for the sales agent's FIRST LLM call (see
 * ai-agent/gemini-cache.ts): the system prompt travels as
 * systemInstruction, the stable shop context as the first user turn,
 * the per-message text as the second user turn.
 *
 * - Gemini: the split shape, with the workspace's explicit cache
 *   attached when cacheName is given (cachedContent). The cached
 *   tokens the reply reports (usageMetadata.cachedContentTokenCount)
 *   flow back in the outcome for the ledger's cached-aware pricing.
 * - Any other resolved provider: the flat prompt, exactly like
 *   callAiForWorkspace.
 * - On ANY Gemini failure (or no key), the Groq fallback gets the
 *   FLAT prompt (system + stable + variable joined) via callGroq —
 *   Groq never goes through the cache, and its outcome reports
 *   cachedInputTokens 0. The fallback is recorded as fallbackFrom,
 *   exactly like callAiForWorkspace. When Gemini ERRORED and Groq
 *   also failed, the Gemini error is THROWN (same honest-failure rule
 *   as callAiForWorkspace) so agent.ts records the real cause.
 * Returns null only when nothing could answer AND nothing errored
 * (no key anywhere).
 */
export interface SplitAiCallInput {
  systemInstruction: string;
  /** Stable shop context (knowledge + delivery charges + products). */
  stableText: string;
  /** Per-message variable text (customer, history, new messages). */
  variableText: string;
  /** Explicit cache to attach (cachedContents/<id>), or null = uncached. */
  cacheName: string | null;
}

export async function callAiForWorkspaceSplit(
  workspaceId: string,
  input: SplitAiCallInput,
  choice?: WorkspaceAiChoice,
): Promise<AiCallOutcome | null> {
  const resolved = choice ?? (await resolveWorkspaceAi(workspaceId));
  const flatPrompt = `${input.systemInstruction}\n\n${input.stableText}\n\n${input.variableText}`;
  if (resolved.provider === 'gemini') {
    if (isMockProvider('gemini')) {
      return mockResult('gemini', resolved.model);
    }
    let geminiError: Error | null = null;
    try {
      const result = await callGeminiWithCache(
        {
          systemInstruction: input.systemInstruction,
          stableText: input.stableText,
          variableText: input.variableText,
          cachedContent: input.cacheName,
        },
        resolved.model,
      );
      if (result) return { ...result, provider: 'gemini', model: resolved.model };
      console.error('[ai] provider gemini not configured (no key) — falling back to groq');
    } catch (err) {
      geminiError = err as Error;
      console.error(
        `[ai] provider gemini failed (${geminiError.message}) — falling back to groq`,
      );
    }
    try {
      const fallback = await callProvider('groq', flatPrompt);
      if (fallback) return { ...fallback, fallbackFrom: 'gemini' };
    } catch (err) {
      console.error(`[ai] groq fallback also failed: ${(err as Error).message}`);
    }
    if (geminiError) {
      throw new Error(`gemini failed: ${geminiError.message} (backup Groq also failed)`);
    }
    return null;
  }
  // Non-Gemini resolved provider: the flat prompt, same as before.
  return callAiForWorkspace(workspaceId, flatPrompt, choice);
}
