import express, { type Request, type Response } from 'express';
import { processDueScheduledPosts } from '../scheduling/publisher';
import { processDueFollowups } from '../followups/engine';
import { runAutoFollowups } from '../followups/auto';
import { processDueHandovers } from '../handover/engine';
import { processOwnerWalletDeductions } from '../owner/sweep';
import { processDueShipmentChecks } from '../courier/tracking-check';

/**
 * Vercel cron endpoint — POST/GET /api/cron/sweep.
 *
 * On Vercel there is no always-on process, so the 60 s in-process sweep
 * in src/index.ts never runs. A free GitHub Actions workflow
 * (.github/workflows/cron-sweep.yml) calls this endpoint every 5 minutes
 * instead. The endpoint runs the SAME four sweep functions, in the SAME
 * order, regardless of DB mode (PGlite or real Postgres).
 *
 * Guard: CRON_SECRET must be set in the environment, and the caller must
 * send the same value as the `x-cron-secret` header, an
 * `Authorization: Bearer <secret>` header, or a `?secret=` query param.
 * Without a matching secret this returns 401 — never run the sweeps.
 * Locally (no CRON_SECRET set) the endpoint always 401s; the local
 * in-process sweep in src/index.ts is unaffected.
 */
export const cronRouter = express.Router();

function providedSecret(req: Request): string {
  const header = req.headers['x-cron-secret'];
  if (typeof header === 'string' && header) return header;
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const q = req.query.secret;
  if (typeof q === 'string' && q) return q;
  return '';
}

cronRouter.all('/cron/sweep', async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret || providedSecret(req) !== secret) {
    res.status(401).json({ error: 'Unauthorized — a valid CRON_SECRET is required' });
    return;
  }
  try {
    const posts = await processDueScheduledPosts();
    const followups = await processDueFollowups();
    const autoFollowups = await runAutoFollowups();
    const handovers = await processDueHandovers();
    const ownerCosts = await processOwnerWalletDeductions();
    const shipments = await processDueShipmentChecks();
    console.log('[cron:sweep] due scheduled posts / follow-ups / auto follow-ups / handovers / owner AI costs / shipments:', {
      posts,
      followups,
      autoFollowups,
      handovers,
      ownerCosts,
      shipments,
    });
    res.json({ ok: true, posts, followups, autoFollowups, handovers, ownerCosts, shipments });
  } catch (err) {
    console.error('[cron:sweep] failed:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});
