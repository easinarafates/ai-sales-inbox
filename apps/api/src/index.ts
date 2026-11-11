import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
// express-async-errors (security fix M1, 2026-11-11): Express 4 drops
// errors thrown in async route handlers — the request hangs until the
// client times out (~60s) instead of getting a 500. This one import
// patches Express so async errors reach the error middleware below.
import 'express-async-errors';
import { config } from './config';
import { isPgliteMode } from './db/pglite';
import { authRouter, profileRouter, workspacesRouter } from './auth/routes';
import { billingRouter } from './billing/routes';
import { channelsRouter } from './channels/routes';
import { facebookOAuthRouter } from './channels/facebook-oauth';
import { instagramOAuthRouter } from './channels/instagram-oauth';
import { tiktokOAuthRouter } from './channels/tiktok-oauth';
import { whatsappOAuthRouter } from './channels/whatsapp-oauth';
import { youtubeOAuthRouter } from './channels/youtube-oauth';
import { socialApiRouter } from './channels/social-routes';
import { inboxRouter } from './inbox/routes';
import { knowledgeRouter } from './knowledge/routes';
import { ordersRouter } from './orders/routes';
import { publicInvoiceRouter } from './orders/public-invoice';
import { productsRouter } from './products/routes';
import { webhooksRouter } from './webhooks/routes';
import { tiktokDmRouter } from './webhooks/tiktok-dm';
import { metaRouter } from './webhooks/meta';
// Phase 2/3 routers (full /api/... paths inside each router — mount at /api).
import { analyticsRouter } from './analytics/routes';
import { postsAnalyticsRouter } from './analytics/posts-routes';
import { pagePostsAnalysisRouter } from './analytics/page-posts-analysis';
import { commentsRouter } from './comments/routes';
import { couponsRouter } from './coupons/routes';
import { customersRouter } from './customers/routes';
import { followupsRouter } from './followups/routes';
import { leadsRouter } from './leads/routes';
import { reviewsRouter } from './reviews/routes';
import { schedulingRouter } from './scheduling/routes';
import { subscriptionsRouter } from './subscriptions/routes';
import { courierRouter } from './courier/routes';
import { topupRouter } from './billing/topup';
import { processDueScheduledPosts } from './scheduling/publisher';
import { processDueFollowups } from './followups/engine';
import { runAutoFollowups } from './followups/auto';
// Worker B — new AiPraktor-style features (API + DB + web pages).
import { imageMatchRouter } from './image-match/routes';
import { handoverRouter } from './handover/routes';
import { voiceOrdersRouter } from './voice-orders/routes';
import { savedRepliesRouter } from './saved-replies/routes';
import { teamRouter } from './team/routes';
import { ticketsRouter } from './tickets/routes';
import { websiteChatRouter } from './website-chat/routes';
import { setupRouter } from './setup/routes';
import { aiProvidersRouter } from './ai-providers/routes';
import { ownerRouter } from './owner/routes';
import { ownerAiChatRouter } from './owner/ai-chat';
import { notificationsRouter } from './notifications/routes';
import { deliveryChargesRouter } from './delivery-charges/routes';
import { processOwnerWalletDeductions } from './owner/sweep';
import { processDueHandovers } from './handover/engine';
import { cronRouter } from './cron/routes';
import { ensureAiPromptCacheSchema, ensureOwnerAiChatSchema, ensureOwnerPanelManageSchema, ensurePageReadSchema, ensurePhase2BillingSchema, ensureProductVariantsSchema, ensureTasks314151617Schema, ensureTasks789Schema, ensureTopupPurposeSchema, ensureUserPhoneSchema } from './db/migrate-prod';

const app = express();
// Behind Vercel the real client IP arrives in X-Forwarded-For — trust
// the first proxy hop so req.ip (used by the login rate limiter) is the
// visitor, not Vercel's edge.
app.set('trust proxy', 1);
// M4: never advertise the framework.
app.disable('x-powered-by');
app.use(cors());
// M4: browser safety headers on every API response (the API only ever
// returns JSON/JS, so a strict policy is safe here).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  next();
});
// JSON limit raised for Worker C's base64 media uploads: a 25 MB file is
// ~34 MB as base64 text, so '1mb' rejected everything over ~1 MB before
// it reached the upload handler (HTTP 413). 40 MB covers the 25 MB cap.
// The verify hook stashes the RAW body on webhook requests only —
// Meta/WhatsApp sign the raw bytes (X-Hub-Signature-256), so the
// signature check needs them; other routes never pay the memory cost.
app.use(
  express.json({
    limit: '40mb',
    verify: (req, _res, buf) => {
      if (typeof req.url === 'string' && req.url.startsWith('/api/webhooks/')) {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      }
    },
  }),
);

// Worker C — public media uploads (LOCAL / cPanel ONLY): files are
// stored under <api-working-dir>/uploads and served as GET /uploads/<file>
// WITHOUT auth so <img>/<video> previews work. On Vercel the filesystem
// is read-only — mkdirSync at import time would crash the function on
// cold start — so this whole block is skipped there (uploads go to
// Vercel Blob and are served as public Blob URLs instead). Filenames are
// random UUIDs, so the URLs are unguessable; nothing else is served.
const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
if (!process.env.VERCEL) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  app.use('/uploads', express.static(UPLOAD_DIR, { index: false, maxAge: '7d' }));
}

// Safety net: one bad request (e.g. an invalid uuid in a route param)
// must never kill the whole API process. Async route handlers that throw
// surface here as unhandled rejections — log them and keep serving.
process.on('unhandledRejection', (err) => {
  console.error('[api] unhandled rejection (server kept alive):', err);
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ai-sales-inbox-api', phase: '1+2+3' });
});

// YEARBITO Phase 2: production (Neon) needs migration 35 applied, and
// the only path that works in this environment is the API applying it
// itself on boot (see db/migrate-prod.ts — `vercel env pull` redacts
// the production DATABASE_URL, so psql cannot be run from here).
// Start it eagerly at boot; the middleware below also awaits it, so the
// first request waits for the schema instead of hitting a missing
// column. PGlite mode is a no-op (the adapter applies the .sql files).
void ensurePhase2BillingSchema();
void ensureProductVariantsSchema();
void ensureTasks789Schema();
void ensureTasks314151617Schema();
void ensureAiPromptCacheSchema();
void ensureUserPhoneSchema();
void ensureTopupPurposeSchema();
void ensurePageReadSchema();
void ensureOwnerAiChatSchema();
void ensureOwnerPanelManageSchema();
app.use(async (_req, _res, next) => {
  await ensurePhase2BillingSchema();
  await ensureProductVariantsSchema();
  await ensureTasks789Schema();
  await ensureTasks314151617Schema();
  await ensureAiPromptCacheSchema();
  await ensureUserPhoneSchema();
  await ensureTopupPurposeSchema();
  await ensurePageReadSchema();
  await ensureOwnerAiChatSchema();
  await ensureOwnerPanelManageSchema();
  next();
});

// Vercel cron endpoint — mounted BEFORE the auth routers below (same
// prefix-claim problem as website-chat / owner): it has its own
// CRON_SECRET check and must never 401 behind requireAuth.
app.use('/api', cronRouter); // /api/cron/sweep (guarded by CRON_SECRET)

// Webhooks are public (Meta verifies with META_VERIFY_TOKEN; webchat with WEBCHAT_SECRET).
app.use('/api/webhooks', webhooksRouter);
app.use('/api/webhooks', tiktokDmRouter); // TikTok DM: GET/POST /api/webhooks/tiktok-dm
app.use('/api/meta', metaRouter); // POST /api/meta/data-deletion (Meta data-deletion callback)
// Worker B — website chat MUST mount here, before the auth routers below:
// every router mounted at /api with a global requireAuth would otherwise
// 401 the public widget.js + message endpoints before they are reached.
// Its /settings route still requires auth (inline requireAuth).
app.use('/api', websiteChatRouter); // /api/website-chat/* (widget.js + message are public)
// Owner Panel mounts at its own prefix /api/owner, before the /api routers
// below that run a global requireAuth: its POST /api/owner/setup bootstrap
// is public (first owner promotion, guarded by OWNER_SETUP_TOKEN /
// no-owner-exists), and would otherwise 401 before it is reached — the
// same prefix-claim problem as the website-chat widget above. Mounting at
// the specific /api/owner prefix (not bare /api) matters: the router's own
// requireOwner middleware must only run for /api/owner/* requests, never
// for the rest of the API.
// Owner AI chat ("AI Sales Manager") mounts BEFORE the Owner Panel
// below, at its own more-specific prefix: the owner router's
// requireOwner platform-owner gate would otherwise 403 every workspace
// owner here (this chat is workspace-owner gated — requireAuth +
// requireWorkspaceOwner, the Task 14 AI Providers pattern — not
// platform-owner gated). Mounting at the specific /api/owner/ai-chat
// prefix (not bare /api) matters for the same reason.
app.use('/api/owner/ai-chat', ownerAiChatRouter); // /api/owner/ai-chat/* (AI Sales Manager — workspace owner only)
app.use('/api/owner', ownerRouter); // /api/owner/* (Owner Panel — platform owner only)

app.use('/api/auth', authRouter);
app.use('/api/profile', profileRouter); // /api/profile/{upload-token,photo} (header Profile menu photo)
app.use('/api/workspaces', workspacesRouter); // POST /api/workspaces/:id/go-live
// Facebook OAuth MUST mount before the /api/channels router below: the
// channels router applies requireAuth to every path, which would 401 the
// public Meta callback (GET /api/channels/facebook/callback) before it
// is reached. The facebook router only answers its own four paths and
// lets everything else fall through to the channels router.
app.use('/api/channels/facebook', facebookOAuthRouter); // /api/channels/facebook/{login,callback,pages,connect}
app.use('/api/channels/instagram', instagramOAuthRouter); // /api/channels/instagram/{login,pages,connect} (callback is the shared /facebook/callback)
app.use('/api/channels/whatsapp', whatsappOAuthRouter); // /api/channels/whatsapp/{login,accounts,connect,manual} (callback is the shared /facebook/callback)
app.use('/api/channels/tiktok', tiktokOAuthRouter); // /api/channels/tiktok/{login,callback} (own TikTok callback)
app.use('/api/channels/youtube', youtubeOAuthRouter); // /api/channels/youtube/{login,callback} (own Google callback)
app.use('/api/channels', channelsRouter);
app.use('/api/inbox', inboxRouter);
app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);
// Public invoice: GET /api/public/invoice/:token — no login, the token is
// the auth (same public-mount rule as website-chat above: it must not sit
// behind any requireAuth).
app.use('/api/public', publicInvoiceRouter);
app.use('/api/billing', billingRouter);
app.use('/api', knowledgeRouter); // /api/knowledge + /api/unanswered
// Phase 2/3 (routers carry full /api/... paths).
app.use('/api', analyticsRouter); // /api/analytics/overview
app.use('/api', postsAnalyticsRouter); // /api/analytics/posts + /api/analytics/lost-sales
app.use('/api', pagePostsAnalysisRouter); // /api/analytics/page-posts (real Graph post analysis)
app.use('/api', commentsRouter); // /api/comments/:postId/carousel
app.use('/api', couponsRouter); // /api/coupons
app.use('/api', customersRouter); // /api/customers (+ merge)
app.use('/api', followupsRouter); // /api/followups
app.use('/api', leadsRouter); // /api/leads
app.use('/api', reviewsRouter); // /api/reviews + /api/orders/:id/request-review
app.use('/api', schedulingRouter); // /api/scheduled-posts
app.use('/api', socialApiRouter); // /api/youtube/* + /api/tiktok/* (live videos/comments/DMs)
app.use('/api', subscriptionsRouter); // /api/subscriptions/* (plans, current, subscribe, upgrade, downgrade, cancel, renew)
app.use('/api', courierRouter); // /api/courier/bookings, /api/courier/track/:trackingNumber, /api/courier/shipments
app.use('/api', topupRouter); // /api/billing/topup/request, /api/billing/topup/requests, /:id/approve, /:id/reject
// Worker B — new features (routers carry full /api/... paths).
app.use('/api', imageMatchRouter); // POST /api/image-match
app.use('/api', handoverRouter); // /api/inbox/:id/handover, /return-to-ai, /inbox/handovers/run
app.use('/api', voiceOrdersRouter); // POST /api/inbox/:id/voice-note, GET /api/inbox/:id/voice-notes
app.use('/api', savedRepliesRouter); // /api/saved-replies
app.use('/api', teamRouter); // /api/team/invites
app.use('/api', ticketsRouter); // /api/tickets (list)
app.use('/api', setupRouter); // /api/setup/*
// MOUNT ORDER (angry-customer fix, 2026-11-11): notifications and
// delivery-charges MUST sit above aiProvidersRouter. That router runs
// router-level requireOwner on a bare /api mount, so anything mounted
// after it is shadowed — a shop owner's GET /api/notifications hit
// requireOwner first and 403'd ("Owner access only"), leaving every
// non-platform-owner shop with an empty bell. These two mounts use
// their own auth and must be reached before the platform-owner gate.
app.use('/api/notifications', notificationsRouter); // /api/notifications (header bell — owner escalation alerts)
app.use('/api/delivery-charges', deliveryChargesRouter); // /api/delivery-charges (owner-set delivery charges per zone)
app.use('/api', aiProvidersRouter); // /api/ai-providers (get + select) — platform-owner only; keep LAST among /api mounts

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`AI Sales Inbox API (Phase 1+2+3) listening on port ${config.port}`);
    // PGlite local mode: the BullMQ worker cannot run (the PGlite data
    // folder can be opened by only one process), so the API itself sweeps
    // due scheduled posts + follow-ups every 60s. With real Postgres +
    // Redis the worker does this instead (workers/queue/src/worker.ts).
    if (isPgliteMode()) {
      const sweep = setInterval(async () => {
        try {
          const posts = await processDueScheduledPosts();
          const followups = await processDueFollowups();
          const autoFollowups = await runAutoFollowups();
          const handovers = await processDueHandovers();
          const ownerCosts = await processOwnerWalletDeductions();
          if (posts.processed > 0 || followups.processed > 0 || autoFollowups.processed > 0 || autoFollowups.scheduled > 0 || handovers.processed > 0 || ownerCosts.deductedRows > 0) {
            console.log('[api:sweep] due scheduled posts / follow-ups / auto follow-ups / handovers / owner AI costs:', { posts, followups, autoFollowups, handovers, ownerCosts });
          }
        } catch (err) {
          console.error('[api:sweep] failed:', (err as Error).message);
        }
      }, 60_000);
      sweep.unref?.();
    }
  });
}

export default app;
