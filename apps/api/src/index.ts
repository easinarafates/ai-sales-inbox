import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { config } from './config';
import { isPgliteMode } from './db/pglite';
import { authRouter, workspacesRouter } from './auth/routes';
import { billingRouter } from './billing/routes';
import { channelsRouter } from './channels/routes';
import { facebookOAuthRouter } from './channels/facebook-oauth';
import { inboxRouter } from './inbox/routes';
import { knowledgeRouter } from './knowledge/routes';
import { ordersRouter } from './orders/routes';
import { productsRouter } from './products/routes';
import { ticketsRouter } from './tickets/routes';
import { webhooksRouter } from './webhooks/routes';
import { tiktokDmRouter } from './webhooks/tiktok-dm';
import { metaRouter } from './webhooks/meta';
// Phase 2/3 routers (full /api/... paths inside each router — mount at /api).
import { analyticsRouter } from './analytics/routes';
import { postsAnalyticsRouter } from './analytics/posts-routes';
import { bookingsRouter } from './bookings/routes';
import { broadcastsRouter } from './broadcasts/routes';
import { commentsRouter } from './comments/routes';
import { couponsRouter } from './coupons/routes';
import { customersRouter } from './customers/routes';
import { featureRequestsRouter } from './feature-requests/routes';
import { followupsRouter } from './followups/routes';
import { leadsRouter } from './leads/routes';
import { migrationRouter } from './migration/routes';
import { reviewsRouter } from './reviews/routes';
import { schedulingRouter } from './scheduling/routes';
import { subscriptionsRouter } from './subscriptions/routes';
import { courierRouter } from './courier/routes';
import { topupRouter } from './billing/topup';
import { processDueScheduledPosts } from './scheduling/publisher';
import { processDueFollowups } from './followups/engine';
// Worker B — new AiPraktor-style features (API + DB + web pages).
import { imageMatchRouter } from './image-match/routes';
import { handoverRouter } from './handover/routes';
import { voiceOrdersRouter } from './voice-orders/routes';
import { savedRepliesRouter } from './saved-replies/routes';
import { agentDeskRouter } from './agent-desk/routes';
import { teamRouter } from './team/routes';
import { websiteChatRouter } from './website-chat/routes';
import { setupRouter } from './setup/routes';
import { aiProvidersRouter } from './ai-providers/routes';
import { ownerRouter } from './owner/routes';
import { processOwnerWalletDeductions } from './owner/sweep';
import { processDueHandovers } from './handover/engine';
import { cronRouter } from './cron/routes';

const app = express();
app.use(cors());
// JSON limit raised for Worker C's base64 media uploads: a 25 MB file is
// ~34 MB as base64 text, so '1mb' rejected everything over ~1 MB before
// it reached the upload handler (HTTP 413). 40 MB covers the 25 MB cap.
app.use(express.json({ limit: '40mb' }));

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
app.use('/api/owner', ownerRouter); // /api/owner/* (Owner Panel — platform owner only)

app.use('/api/auth', authRouter);
app.use('/api/workspaces', workspacesRouter); // POST /api/workspaces/:id/go-live
// Facebook OAuth MUST mount before the /api/channels router below: the
// channels router applies requireAuth to every path, which would 401 the
// public Meta callback (GET /api/channels/facebook/callback) before it
// is reached. The facebook router only answers its own four paths and
// lets everything else fall through to the channels router.
app.use('/api/channels/facebook', facebookOAuthRouter); // /api/channels/facebook/{login,callback,pages,connect}
app.use('/api/channels', channelsRouter);
app.use('/api/inbox', inboxRouter);
app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/tickets', ticketsRouter);
app.use('/api/billing', billingRouter);
app.use('/api', knowledgeRouter); // /api/knowledge + /api/unanswered
// Phase 2/3 (routers carry full /api/... paths).
app.use('/api', analyticsRouter); // /api/analytics/overview
app.use('/api', postsAnalyticsRouter); // /api/analytics/posts + /api/analytics/lost-sales
app.use('/api', bookingsRouter); // /api/bookings (+ receptionist mode)
app.use('/api', broadcastsRouter); // /api/broadcasts (24h window)
app.use('/api', commentsRouter); // /api/comments/:postId/carousel
app.use('/api', couponsRouter); // /api/coupons
app.use('/api', customersRouter); // /api/customers (+ merge)
app.use('/api', featureRequestsRouter); // /api/feature-requests
app.use('/api', followupsRouter); // /api/followups
app.use('/api', leadsRouter); // /api/leads
app.use('/api', migrationRouter); // /api/migration/import
app.use('/api', reviewsRouter); // /api/reviews + /api/orders/:id/request-review
app.use('/api', schedulingRouter); // /api/scheduled-posts
app.use('/api', subscriptionsRouter); // /api/subscriptions/* (plans, current, subscribe, upgrade, downgrade, cancel, renew)
app.use('/api', courierRouter); // /api/courier/bookings, /api/courier/track/:trackingNumber, /api/courier/shipments
app.use('/api', topupRouter); // /api/billing/topup/request, /api/billing/topup/requests, /:id/approve, /:id/reject
// Worker B — new features (routers carry full /api/... paths).
app.use('/api', imageMatchRouter); // POST /api/image-match
app.use('/api', handoverRouter); // /api/inbox/:id/handover, /return-to-ai, /inbox/handovers/run
app.use('/api', voiceOrdersRouter); // POST /api/inbox/:id/voice-note, GET /api/inbox/:id/voice-notes
app.use('/api', savedRepliesRouter); // /api/saved-replies
app.use('/api', agentDeskRouter); // /api/agent-desk/*
app.use('/api', teamRouter); // /api/team/invites
app.use('/api', setupRouter); // /api/setup/*
app.use('/api', aiProvidersRouter); // /api/ai-providers (get + select)

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
          const handovers = await processDueHandovers();
          const ownerCosts = await processOwnerWalletDeductions();
          if (posts.processed > 0 || followups.processed > 0 || handovers.processed > 0 || ownerCosts.deductedRows > 0) {
            console.log('[api:sweep] due scheduled posts / follow-ups / handovers / owner AI costs:', { posts, followups, handovers, ownerCosts });
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
