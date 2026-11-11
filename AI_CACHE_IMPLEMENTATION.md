# YEARBITO — 24h Gemini prompt caching (2026-11-11)

## What was built

The sales agent's prompt is split into a **stable prefix** (system prompt +
shop context: knowledge + delivery charges + products) and a **variable
suffix** (customer, orders, history, new messages). The stable prefix can
live in a Gemini explicit `cachedContent` (TTL 24h) so those tokens are
priced at the cached-input rate instead of the full input rate. Every
cache error falls back silently to an uncached reply — a customer reply
never fails because of caching.

## Files changed

| File | Change |
|---|---|
| `apps/api/src/ai-agent/gemini-cache.ts` | **New.** Explicit-cache lifecycle: `getOrCreateWorkspaceCache`, `invalidateWorkspacePromptCache`, `hashStableContext`. Volume gate, idle expiry, 1h failure throttle, countTokens sizing. All failures → "unavailable", never thrown. |
| `apps/api/src/ai-agent/gemini.ts` | `GeminiResult` gains `cachedInputTokens` (from `usageMetadata.cachedContentTokenCount`, default 0). New `callGeminiWithCache` (systemInstruction + two user turns + optional `cachedContent`). `callGemini(prompt, model)` unchanged. |
| `apps/api/src/ai-agent/pricing.ts` | Cached-input rate for gemini-3.5-flash-lite: **$0.03/1M**. `computeAiCostPaisa` takes optional 5th arg `cachedInputTokens` (default 0); old 4-arg calls unchanged. |
| `apps/api/src/ai-agent/providers.ts` | `cachedInputTokens` flows through `AiCallOutcome` (mock = 0). New `callAiForWorkspaceSplit` — Gemini via the split/cached call, Groq fallback via the **flat** prompt (never through the cache). |
| `apps/api/src/ai-agent/prompts.ts` | `buildUserPrompt` refactored into `buildStableContext` (knowledge + delivery charges + products) and `buildVariablePrompt` (customer + addressing + orders + history + new messages + closing). Section text is **byte-identical** to before (verified by unit test: stable + variable sections reassemble to `buildUserPrompt` exactly). |
| `apps/api/src/ai-agent/agent.ts` | First LLM call always uses the split shape (systemInstruction + stable turn + variable turn), with the explicit cache attached when available. `cachedInputTokens` threaded to every `chargeForReply` after an AI call (incl. order-confirmed / cancel / order-confirmation-blocked early returns) and accumulated across the second LLM call. `chargeForReply` records `cached_input_tokens` in the ledger. One log line per Gemini reply: `[ai-cache] ws=… input=… cached=… output=… providerCostPaisa=… cache=hit\|miss\|unavailable`. Second LLM call, demo mode, billing rules untouched. |
| `apps/api/src/db/migrations/39-ai-prompt-cache.sql` | **New, idempotent.** `ai_usage_ledger.cached_input_tokens INT DEFAULT 0`; `ai_prompt_caches` table (workspace PK, cache_name, context_hash, token_count, expires_at, last_used_at, created_at) + expiry index. |
| `apps/api/src/db/migrate-prod.ts` | `MIGRATION_39_SQL` embedded (exact copy) + `ensureAiPromptCacheSchema()` (same pattern as 35–38). |
| `apps/api/src/index.ts` | `ensureAiPromptCacheSchema()` wired eagerly + in the per-request middleware. |
| `scripts/check-migration-39-embedded.mjs` | **New.** Verifies the embedded SQL matches the .sql file (copy of the 38 script). |
| `apps/api/src/products/routes.ts` | Invalidate on product create / PATCH / adjust-stock / delete. |
| `apps/api/src/products/stock.ts` | Invalidate after `decrementStockForOrderItems` moves stock (covers AI + HTTP order creation). |
| `apps/api/src/knowledge/routes.ts` | Invalidate on knowledge create / PATCH / delete / teach / apply-change / rollback. |
| `apps/api/src/delivery-charges/service.ts` | Invalidate in `setDeliveryChargeRules` + `setBusinessDistrict`. |
| `scripts/verify-ai-prompt-cache.mjs` | **New.** End-to-end verifier (unit + live Gemini webchat + ledger peek). Run: `node scripts/verify-ai-prompt-cache.mjs` |
| `scripts/peek-cache-ledger.mjs` | **New.** Helper for the verifier: dumps ledger + cache rows for a workspace from a stopped PGlite dir, recomputing the cached-aware cost per row. |

## Design decisions

- **Split shape always, cache optional.** The first call is always
  systemInstruction + two user turns, with or without `cachedContent`
  attached — so behaviour is identical with and without a cache. (Probed
  live: two consecutive user turns return HTTP 200 with the correct answer.)
- **Explicit caching is volume-gated (required by the economics).**
  A cache is created only if the workspace had **≥ 4 AI replies in the
  last 60 minutes**, and caches idle **> 2 hours** are deleted on load.
  Stable prefixes under 1024 tokens are never cached (Gemini minimum).
- **Free-tier reality.** Explicit cache creation on this key returns
  HTTP 429 `TotalCachedContentStorageTokensPerModelFreeTier limit
  exceeded … limit=0` — context caching is not available on the free
  tier. Creation failure → "unavailable", throttled to **one attempt per
  hour per workspace** (in-memory), reply goes out uncached. Implicit
  caching still works best-effort and is read from every reply
  (`cachedContentTokenCount`).
- **Stale-data guard.** `invalidateWorkspacePromptCache` (delete Gemini
  cache best-effort + delete DB row) is called from every write path
  that changes cached content. On load, a hash mismatch between the
  current stable context and the stored `context_hash` also deletes +
  recreates. A price change is visible in the very next reply.
- **No model, price, billing, or fallback change.** gemini-3.5-flash-lite
  only; wallet charges are the same flat rules; Groq fallback keeps the
  flat prompt; the second LLM call is unchanged and uncached.

## Volume-gate math (break-even)

Official Standard-tier pricing for gemini-3.5-flash-lite
(ai.google.dev/gemini-api/docs/pricing): input $0.30/1M, cached input
$0.03/1M, cache storage $1.00/1M tokens/hour.

- Storage for a 3,517-token prefix: 0.003517M × $1.00 × 24h = **$0.084/day
  ≈ 1,029 paisa/day**.
- Saving per cached reply: 3,517 × ($0.30 − $0.03)/1M × 12,200 paisa/$
  ≈ **11.6 paisa**.
- Break-even: 1,029 / 11.6 ≈ **89 replies/day per shop**. The busiest
  shop does ~46/day — below break-even — hence the ≥ 4 replies/hour gate
  (≈ 96/day pace) and the 2-hour idle delete.

## Local measured numbers (2026-11-11, real Gemini key, PGlite)

Verifier: `node scripts/verify-ai-prompt-cache.mjs` — **33/33 checks passed**.
Existing verifier `node scripts/verify-ai-providers.mjs` — **52/52 passed**
(no regression; its live Gemini reply also used the new split shape).

- Prompt tokens per reply (1 product, short history): **3,598–3,784 input**,
  **28–44 output**. Provider cost **14–15 paisa/reply** uncached.
- Cached tokens: **0 on all 6 replies** — implicit caching did not hit
  in this run (best-effort; earlier probes saw 3 hits in 9 calls, 2,000
  tokens each). Ledger rows carry `cached_input_tokens = 0` and
  `provider_cost_paisa` matching the cached-aware formula on every row.
- Explicit-cache attempt (5th reply, gate passed at 4 prior replies in
  the hour): `countTokens` measured the stable prefix at **3,349 tokens**,
  then creation failed exactly as probed —
  `429 TotalCachedContentStorageTokensPerModelFreeTier limit exceeded …
  limit=0` — reply still went out correctly with the right price, and the
  throttle meant **no second creation attempt** (6th reply, 1 attempt total).
- Invalidation: PATCH price ৳1500 → ৳1750, next reply quoted **৳১৭৫০**
  and never the old ৳1500.
- Hash-mismatch path (separate check against the real module + scratch
  DB): stale row deleted on load (1 → 0 rows); `invalidateWorkspacePromptCache`
  deletes the row (1 → 0). The Gemini DELETE of a bogus cache name fails
  best-effort (403) and is ignored.
- Unit checks: cached-aware cost (3,890 in / 3,517 cached / 100 out) =
  **6 paisa** vs 17 paisa uncached; prompt split reassembles
  byte-identically; hash changes on a price change.

## Known limitations / follow-ups

- Explicit caching is **unavailable on the current free-tier key** (429,
  limit=0). It will start working if the Google Cloud project moves to a
  paid tier — no code change needed; the volume gate + throttle already
  protect the economics. The `cache=hit` log line will then appear.
- The old `verify-ai-providers.mjs` live-cost check assumes cached = 0.
  If implicit caching ever hits during that verifier's live reply, its
  expected-cost assertion will be too high (the ledger will correctly
  show the lower cached-aware cost). That verifier may need its expected
  math updated to the cached-aware formula.
- `countTokens` in v1beta does **not** accept `systemInstruction`
  (HTTP 400); the code counts the system prompt + stable text as two
  parts of one user turn instead (same token total).
