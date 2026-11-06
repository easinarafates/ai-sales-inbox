import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Central configuration. The AI model name lives ONLY here.
 * Change the model in one line (env AI_MODEL) — never hardcode it elsewhere.
 */
export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: optional('REDIS_URL', 'redis://localhost:6379'),
  jwtSecret: required('JWT_SECRET'),
  tokenEncryptionKey: required('TOKEN_ENCRYPTION_KEY'),
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  aiModel: optional('AI_MODEL', 'gemini-2.5-flash'),
  /** AI provider: 'gemini' (paid/billing) or 'groq' (free tier, no card). */
  aiProvider: optional('AI_PROVIDER', 'gemini'),
  groqApiKey: process.env.GROQ_API_KEY ?? '',
  groqModel: optional('GROQ_MODEL', 'openai/gpt-oss-20b'),
  /**
   * Multi-provider AI (Worker: AI providers) — ChatGPT (OpenAI) and
   * Claude (Anthropic). Keys are NEVER hardcoded: set them in .env
   * (OPENAI_API_KEY from platform.openai.com, ANTHROPIC_API_KEY from
   * console.anthropic.com). A provider with no key reports as
   * "not connected" and is never selectable as live.
   */
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiModel: optional('OPENAI_MODEL', 'gpt-6-luna'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  claudeModel: optional('CLAUDE_MODEL', 'claude-sonnet-5-5'),
  /**
   * Test-only mock providers (comma-separated provider ids, e.g.
   * AI_MOCK_PROVIDERS=openai,claude). A mocked provider answers with a
   * canned deterministic reply WITHOUT calling the real API, so the
   * verifier can test dispatch/fallback/cost math without spending money
   * or needing a key. OFF by default — never set in production.
   */
  aiMockProviders: process.env.AI_MOCK_PROVIDERS ?? '',
  /** USD -> BDT conversion for provider token costs (paisa per USD). */
  usdToBdtPaisa: Number(process.env.USD_TO_BDT_PAISA ?? 12200),
  /**
   * Optional JSON override for per-token rates (USD per 1M tokens),
   * e.g. AI_RATES_JSON='{"gpt-4o-mini":{"input":0.15,"output":0.60}}'.
   * Defaults live in apps/api/src/ai-agent/pricing.ts (each provider's
   * published pricing); this only overrides what it names.
   */
  aiRatesJson: process.env.AI_RATES_JSON ?? '',
  /**
   * Per-request timeout (ms) for AI provider HTTP calls. A provider that
   * stalls must fail fast so the agent can fall back to Groq instead of
   * leaving the customer waiting forever (a bare fetch has no timeout).
   * Override with AI_PROVIDER_TIMEOUT_MS.
   */
  aiProviderTimeoutMs: Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 20000),
  freeCreditPaisa: Number(process.env.FREE_CREDIT_PAISA ?? 5000),
  /**
   * সাবস্ক্রিপশন — প্রস্তাবিত দাম (SUGGESTED ONLY — মালিকের সিদ্ধান্ত নয়)।
   * নিচের দামগুলো শুধু প্রস্তাব: ছোট ৳৪৯৯, মাঝারি ৳৯৯৯, বড় ৳১৯৯৯/মাস।
   * মালিক দাম বদলাতে চাইলে জানালেই বদলে দেওয়া হবে — দাম বদলাতে কোডের
   * আর কোথাও হাত দিতে হয় না: DB-র plans টেবিল (মাইগ্রেশন 04-এ সিড করা)
   * আর এখানকার suggestedPlans-ই একমাত্র জায়গা। রানটাইমে আসল উৎস
   * plans টেবিল; এখানকার তালিকাটি ডকুমেন্টেশন/ফলব্যাক হিসেবে আছে।
   * নতুন ওয়ার্কস্পেস ১৪ দিনের ফ্রি ট্রায়াল পায় (ছোট প্ল্যান)।
   * প্ল্যানের সীমা শেষ হলে প্রতি অতিরিক্ত AI রিপ্লাইয়ে ১০ পয়সা কাটে।
   */
  trialDays: Number(process.env.TRIAL_DAYS ?? 14),
  subscriptionPeriodDays: Number(process.env.SUBSCRIPTION_PERIOD_DAYS ?? 30),
  overageReplyCostPaisa: Number(process.env.OVERAGE_REPLY_COST_PAISA ?? 10),
  /**
   * Test hooks (POST /api/subscriptions/test/*) — OFF by default.
   * They can only harm the caller's own workspace, but they must never
   * be live in production: start the API with
   * ALLOW_SUBSCRIPTION_TEST_HOOKS=true only to run
   * scripts/verify-subscriptions.mjs locally.
   */
  allowSubscriptionTestHooks: process.env.ALLOW_SUBSCRIPTION_TEST_HOOKS === 'true',
  /**
   * Owner Panel bootstrap + test hooks (migration 11).
   * OWNER_SETUP_TOKEN: if set, POST /api/owner/setup must send it to
   * promote a user to platform owner. If unset, promotion is allowed
   * ONLY while no owner exists yet (first-run bootstrap). Set a token
   * in production.
   * ALLOW_OWNER_TEST_HOOKS=true only to run scripts/verify-owner-panel.mjs
   * locally — it enables POST /api/owner/_test/seed-ledger.
   */
  ownerSetupToken: process.env.OWNER_SETUP_TOKEN ?? '',
  allowOwnerTestHooks: process.env.ALLOW_OWNER_TEST_HOOKS === 'true',
  suggestedPlans: [
    { slug: 'choto', nameBn: 'ছোট', pricePaisa: 49900, includedAiReplies: 500, maxChannels: 1, maxProducts: 100 },
    { slug: 'majhari', nameBn: 'মাঝারি', pricePaisa: 99900, includedAiReplies: 2000, maxChannels: 3, maxProducts: 500 },
    { slug: 'boro', nameBn: 'বড়', pricePaisa: 199900, includedAiReplies: 8000, maxChannels: null, maxProducts: null },
  ],
  s3: {
    endpoint: optional('S3_ENDPOINT', 'http://localhost:9000'),
    accessKey: optional('S3_ACCESS_KEY', 'minioadmin'),
    secretKey: optional('S3_SECRET_KEY', 'minioadmin123'),
    bucket: optional('S3_BUCKET', 'ai-inbox'),
  },
  meta: {
    appId: process.env.META_APP_ID ?? '',
    appSecret: process.env.META_APP_SECRET ?? '',
    verifyToken: optional('META_VERIFY_TOKEN', ''),
    /**
     * Facebook OAuth (Login with Facebook) — the redirect URI Meta calls
     * back to after the user approves. Local dev default points at the
     * local API; production MUST set META_OAUTH_REDIRECT_URI to the live
     * API callback (https://ai-sales-inbox-api.vercel.app/api/channels/facebook/callback)
     * and the same URI must be registered in the Meta app.
     */
    oauthRedirectUri: process.env.META_OAUTH_REDIRECT_URI ?? 'http://localhost:4000/api/channels/facebook/callback',
  },
  /**
   * Where the web app lives. OAuth callbacks redirect back here
   * (…/channels?facebook=connected|pick|error). Production MUST set
   * WEB_APP_URL to https://ai-sales-inbox-web.vercel.app.
   */
  webAppUrl: optional('WEB_APP_URL', 'http://localhost:3000'),
  webchatSecret: process.env.WEBCHAT_SECRET ?? '',
  seedDemo: process.env.SEED_DEMO === 'true',
  /**
   * Phase 2/3 approval gates (PDF §6/§9) — false until the platform approves.
   * WhatsApp Cloud API and TikTok API access are granted by Meta/TikTok,
   * not by us; until then the channels save as pending_approval and
   * TikTok posts are never published.
   */
  whatsappApproved: process.env.WHATSAPP_APPROVED === 'true',
  tiktokCommentsApproved: process.env.TIKTOK_COMMENTS_APPROVED === 'true',
  tiktokSchedulingAudited: process.env.TIKTOK_SCHEDULING_AUDITED === 'true',
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
  /** Embedding provider for image product matching ('' = stub — never fakes a match). */
  embeddingProvider: process.env.EMBEDDING_PROVIDER ?? '',
  /**
   * OpenAI-compatible embeddings endpoint (used only when
   * EMBEDDING_PROVIDER=openai-compatible AND all three below are set).
   * EMBEDDING_API_URL is the API base, e.g. https://api.example.com/v1
   * ("/embeddings" is appended unless the URL already ends with it).
   * The key is never logged. No key/URL/model → the stub stays active.
   */
  embeddingApiUrl: process.env.EMBEDDING_API_URL ?? '',
  embeddingApiKey: process.env.EMBEDDING_API_KEY ?? '',
  embeddingModel: process.env.EMBEDDING_MODEL ?? '',
  /**
   * TikTok DM gate — false until TikTok approves DM (Messaging API) access.
   * Until then the TikTok DM channel saves as pending_approval and the DM
   * webhook rejects incoming DMs (nothing is received or sent).
   */
  tiktokDmApproved: process.env.TIKTOK_DM_APPROVED === 'true',
  tiktokDmVerifyToken: process.env.TIKTOK_DM_VERIFY_TOKEN ?? '',
  /**
   * Courier provider selection: 'stub' (default — saves the booking request
   * locally only, no tracking number) | 'pathao' | 'steadfast' | 'redx'.
   * Real providers fail honestly until their API keys are configured.
   */
  courierProvider: optional('COURIER_PROVIDER', 'stub'),
  courier: {
    pathao: {
      baseUrl: optional('PATHAO_BASE_URL', ''),
      clientId: process.env.PATHAO_CLIENT_ID ?? '',
      clientSecret: process.env.PATHAO_CLIENT_SECRET ?? '',
      username: process.env.PATHAO_USERNAME ?? '',
      password: process.env.PATHAO_PASSWORD ?? '',
    },
    steadfast: {
      baseUrl: optional('STEADFAST_BASE_URL', ''),
      apiKey: process.env.STEADFAST_API_KEY ?? '',
      secretKey: process.env.STEADFAST_SECRET_KEY ?? '',
    },
    redx: {
      baseUrl: optional('REDX_BASE_URL', ''),
      apiKey: process.env.REDX_API_KEY ?? '',
    },
  },
  /**
   * Payment gateway placeholders — ENV NAMES ONLY, no credentials here.
   * Live bKash/Nagad needs merchant credentials from the provider:
   * bKash merchant account (username/password/app key/app secret from the
   * bKash merchant dashboard) and Nagad merchant account (merchant ID +
   * public/private keys from the Nagad merchant portal). Until those are
   * set, top-ups use the MANUAL flow (billing/topup.ts): the payer sends
   * money by hand and submits the transaction id for review.
   */
  bkash: {
    baseUrl: optional('BKASH_BASE_URL', ''),
    username: process.env.BKASH_USERNAME ?? '',
    password: process.env.BKASH_PASSWORD ?? '',
    appKey: process.env.BKASH_APP_KEY ?? '',
    appSecret: process.env.BKASH_APP_SECRET ?? '',
  },
  nagad: {
    baseUrl: optional('NAGAD_BASE_URL', ''),
    merchantId: process.env.NAGAD_MERCHANT_ID ?? '',
    publicKey: process.env.NAGAD_PUBLIC_KEY ?? '',
    privateKey: process.env.NAGAD_PRIVATE_KEY ?? '',
  },
} as const;

export type Config = typeof config;
