import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router, type Response } from 'express';
import { put } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';
import { callGroq } from '../ai-agent/groq';
import { analyzePostMedia } from './media-caption';
import { publishScheduledPost, processDueScheduledPostsForWorkspace, type ScheduledPostRow } from './publisher';
import { enqueueScheduledPost } from './queue';

export const schedulingRouter = Router();

/**
 * Local media uploads (no S3, no money).
 * Files are stored under <api-working-dir>/uploads and served at
 * /api/uploads/<file> by the static route below.
 *
 * KNOWN LIMIT (needs the coordinator / index.ts): this static route
 * lives inside schedulingRouter, which is mounted at /api AFTER other
 * routers (knowledge, analytics, …) that run requireAuth on every
 * /api/* path — so an unauthenticated <img>/<video> request to
 * /api/uploads/... is stopped with 401 before it reaches this route.
 * Authenticated requests DO serve (verified). The web UI therefore
 * fetches upload previews with the auth token (see
 * fetchAuthedMediaUrl in apps/web/lib/api-scheduling.ts). For truly
 * public serving, index.ts needs one line before the routers:
 *   app.use('/uploads', express.static(<uploads dir>))
 * and the returned URLs change from /api/uploads/<file> to
 * /uploads/<file>. Until then, uploads are only reachable by their
 * random UUID filename AND with a valid token.
 */
const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
// Vercel: read-only filesystem — never mkdir at import time (would crash
// the function on cold start) and never serve from disk (uploads go to
// Vercel Blob). Locally / on cPanel the disk fallback below still runs.
if (!process.env.VERCEL) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  schedulingRouter.use('/uploads', express.static(UPLOAD_DIR, { index: false, maxAge: '7d' }));
}

schedulingRouter.use(requireAuth);

/**
 * POST /api/scheduled-posts/upload-token — client token for direct
 * browser→Vercel Blob upload (Vercel only). The web calls this via
 * @vercel/blob/client `upload()` with its Authorization header, then the
 * browser uploads the file straight to Blob — bypassing the API
 * function's 4.5 MB request-body cap. Locally (no BLOB_READ_WRITE_TOKEN)
 * this returns 503 and the web falls back to the base64 /upload endpoint.
 */
schedulingRouter.post('/scheduled-posts/upload-token', async (req: AuthRequest, res: Response) => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ error: 'Blob storage is not configured (BLOB_READ_WRITE_TOKEN missing)' });
    return;
  }
  try {
    const jsonResponse = await handleUpload({
      body: req.body as HandleUploadBody,
      request: req as unknown as Request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          'image/jpeg',
          'image/png',
          'image/gif',
          'image/webp',
          'video/mp4',
          'video/webm',
          'video/quicktime',
        ],
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        addRandomSuffix: true,
      }),
      onUploadCompleted: async ({ blob }) => {
        console.log('[blob] direct upload completed:', blob.url);
      },
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Scheduling rules (Worker C — approved demo parity):
 * - MAX_POSTS_PER_DAY = 15 scheduled posts per workspace per calendar
 *   day (Asia/Dhaka). Only posts that OCCUPY a slot count: status
 *   'scheduled' or 'publishing'. Drafts (even with a scheduled_at) do
 *   NOT occupy a slot, and published / cancelled / failed posts free
 *   their slot — so publishing a post lets a new one take its place.
 * - WINDOW_DAYS = 7: scheduled_at must be within the next 7 days from
 *   now (and not in the past, apart from a 5-minute clock-skew grace).
 */
export const MAX_POSTS_PER_DAY = 15;
export const WINDOW_DAYS = 7;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

const POST_COLUMNS =
  'id, caption, media_urls, media_type, platforms, scheduled_at, status, platform_post_id, created_at, updated_at';

type PostBody = {
  caption?: string;
  mediaUrls?: string[];
  mediaType?: string;
  platforms?: string[];
  scheduledAt?: string | null;
  productIds?: string[];
};

type MediaType = 'image' | 'video' | 'text';

const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'];

const MIME_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
};

function inferMediaType(mediaUrls: string[]): MediaType {
  for (const u of mediaUrls) {
    const lower = u.split('?')[0].toLowerCase();
    if (VIDEO_EXTS.some((e) => lower.endsWith(e))) return 'video';
  }
  if (mediaUrls.length > 0) return 'image';
  return 'text';
}

function isValidMediaType(value: unknown): value is MediaType {
  return value === 'image' || value === 'video' || value === 'text';
}

function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

/** Calendar date (YYYY-MM-DD) of an ISO timestamp in Asia/Dhaka. */
function dhakaDateOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** [start, end) ISO bounds (with +06:00) of a Dhaka calendar day. */
function dhakaDayBounds(date: string): [string, string] {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const pad = (n: number): string => String(n).padStart(2, '0');
  const nextDate = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  return [`${date}T00:00:00+06:00`, `${nextDate}T00:00:00+06:00`];
}

/**
 * How many posts occupy a slot on a Dhaka calendar day. Only
 * 'scheduled' / 'publishing' count — published posts free their slot.
 */
async function occupyingCount(
  workspaceId: string,
  date: string,
  excludePostId?: string | null,
): Promise<number> {
  const [start, end] = dhakaDayBounds(date);
  const { rows } = await query<{ n: string }>(
    workspaceId,
    `SELECT count(*) AS n FROM scheduled_posts
     WHERE workspace_id = $1
       AND status IN ('scheduled', 'publishing')
       AND scheduled_at >= $2 AND scheduled_at < $3
       AND ($4::text IS NULL OR id <> $4::uuid)`,
    [workspaceId, start, end, excludePostId ?? null],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Per-day occupying counts { 'YYYY-MM-DD': n } for the whole workspace. */
async function dayCounts(workspaceId: string): Promise<Record<string, number>> {
  const { rows } = await query<{ scheduled_at: string }>(
    workspaceId,
    `SELECT scheduled_at FROM scheduled_posts
     WHERE workspace_id = $1 AND status IN ('scheduled', 'publishing')
       AND scheduled_at IS NOT NULL`,
    [workspaceId],
  );
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const date = dhakaDateOf(row.scheduled_at);
    counts[date] = (counts[date] ?? 0) + 1;
  }
  return counts;
}

/** Returns an error message when scheduledAt breaks the 7-day window, else null. */
function windowError(scheduledAt: string): string | null {
  const when = new Date(scheduledAt).getTime();
  const now = Date.now();
  if (when < now - 5 * 60 * 1000) {
    return 'scheduledAt অতীতের তারিখ হতে পারবে না (past date not allowed)';
  }
  if (when > now + WINDOW_DAYS * 24 * 60 * 60 * 1000) {
    return `শিডিউল করা যায় সর্বোচ্চ ${WINDOW_DAYS} দিন আগে পর্যন্ত (scheduled_at must be within the next ${WINDOW_DAYS} days)`;
  }
  return null;
}

async function assertSlotFree(
  workspaceId: string,
  scheduledAt: string,
  excludePostId?: string | null,
): Promise<string | null> {
  const date = dhakaDateOf(scheduledAt);
  const count = await occupyingCount(workspaceId, date, excludePostId);
  if (count >= MAX_POSTS_PER_DAY) {
    return `এই দিনে (${date}) ইতিমধ্যে ${MAX_POSTS_PER_DAY}টি পোস্ট শিডিউল করা আছে — আর পোস্ট যোগ করা যাবে না (max ${MAX_POSTS_PER_DAY} scheduled posts per day)`;
  }
  return null;
}

async function loadPost(workspaceId: string, postId: string): Promise<ScheduledPostRow | null> {
  return queryOne<ScheduledPostRow>(
    workspaceId,
    `SELECT ${POST_COLUMNS} FROM scheduled_posts WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, postId],
  );
}

/**
 * Latest failed publish reason per post (from post_publish_logs), so the
 * Schedule page can show WHY a post failed instead of only "Failed".
 */
async function lastErrors(
  workspaceId: string,
  postIds: string[],
): Promise<Record<string, string>> {
  if (postIds.length === 0) return {};
  const { rows } = await query<{ scheduled_post_id: string; error: string | null }>(
    workspaceId,
    `SELECT DISTINCT ON (scheduled_post_id) scheduled_post_id, error FROM post_publish_logs
     WHERE workspace_id = $1 AND scheduled_post_id = ANY($2) AND status = 'failed' AND error IS NOT NULL
     ORDER BY scheduled_post_id, created_at DESC`,
    [workspaceId, postIds],
  );
  const map: Record<string, string> = {};
  for (const r of rows) if (r.error) map[r.scheduled_post_id] = r.error;
  return map;
}

function withLastErrors(posts: ScheduledPostRow[], errors: Record<string, string>): ScheduledPostRow[] {
  return posts.map((p) => (errors[p.id] ? { ...p, lastError: errors[p.id] } : p));
}

async function loadPostProducts(workspaceId: string, postId: string) {
  const { rows } = await query(
    workspaceId,
    `SELECT p.id, p.name, p.price_paisa, p.stock FROM post_products pp
     JOIN products p ON p.id = pp.product_id AND p.workspace_id = $1
     WHERE pp.workspace_id = $1 AND pp.scheduled_post_id = $2`,
    [workspaceId, postId],
  );
  return rows;
}

async function attachProducts(
  workspaceId: string,
  postId: string,
  productIds: string[],
): Promise<void> {
  for (const productId of productIds) {
    const product = await queryOne(
      workspaceId,
      'SELECT id FROM products WHERE workspace_id = $1 AND id = $2',
      [workspaceId, productId],
    );
    if (!product) throw new Error(`Product not found: ${productId}`);
    await query(
      workspaceId,
      `INSERT INTO post_products (workspace_id, scheduled_post_id, product_id)
       SELECT $1, $2, $3 WHERE NOT EXISTS (
         SELECT 1 FROM post_products
         WHERE workspace_id = $1 AND scheduled_post_id = $2 AND product_id = $3
       )`,
      [workspaceId, postId, productId],
    );
  }
}

/** GET /api/scheduled-posts?status=&platform= — includes per-day counts (n/15). */
schedulingRouter.get('/scheduled-posts', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const platform = typeof req.query.platform === 'string' ? req.query.platform : null;
  // Lazy sweep: Vercel has no always-on worker, and the GitHub Actions
  // cron is the only other trigger — so opening the Schedule page also
  // publishes anything already due in this workspace. When nothing is
  // due this is one cheap indexed query; errors never block the list.
  await processDueScheduledPostsForWorkspace(workspaceId).catch((err) =>
    console.error('[scheduling] lazy sweep failed:', (err as Error).message),
  );
  const { rows } = await query<ScheduledPostRow>(
    workspaceId,
    `SELECT ${POST_COLUMNS} FROM scheduled_posts
     WHERE workspace_id = $1
       AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR $3 = ANY(platforms))
     ORDER BY scheduled_at ASC NULLS LAST, created_at DESC LIMIT 200`,
    [workspaceId, status, platform],
  );
  const counts = await dayCounts(workspaceId);
  const errors = await lastErrors(workspaceId, rows.map((r) => r.id));
  res.json({ posts: withLastErrors(rows, errors), counts, maxPerDay: MAX_POSTS_PER_DAY, windowDays: WINDOW_DAYS });
});

/**
 * GET /api/scheduled-posts/calendar?month=YYYY-MM
 * Days keyed by Bangladesh (Asia/Dhaka) calendar date. Declared before
 * /scheduled-posts/:id so "calendar" is not read as a post id.
 */
schedulingRouter.get('/scheduled-posts/calendar', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const month = typeof req.query.month === 'string' ? req.query.month : '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'month is required as YYYY-MM (যেমন 2026-11)' });
    return;
  }
  const [year, mon] = month.split('-').map(Number);
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMon = mon === 12 ? 1 : mon + 1;
  const pad = (n: number): string => String(n).padStart(2, '0');
  // Bangladesh time is UTC+6 all year (no DST); month bounds in +06:00.
  const start = `${year}-${pad(mon)}-01T00:00:00+06:00`;
  const end = `${nextYear}-${pad(nextMon)}-01T00:00:00+06:00`;
  const { rows } = await query<ScheduledPostRow>(
    workspaceId,
    `SELECT ${POST_COLUMNS} FROM scheduled_posts
     WHERE workspace_id = $1 AND scheduled_at >= $2 AND scheduled_at < $3
     ORDER BY scheduled_at ASC`,
    [workspaceId, start, end],
  );
  const dayFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const days: Record<string, ScheduledPostRow[]> = {};
  for (const post of rows) {
    if (!post.scheduled_at) continue;
    const date = dayFmt.format(new Date(post.scheduled_at));
    (days[date] ??= []).push(post);
  }
  const allCounts = await dayCounts(workspaceId);
  const counts: Record<string, number> = {};
  for (const [date, n] of Object.entries(allCounts)) {
    if (date.startsWith(month)) counts[date] = n;
  }
  res.json({ month, days, counts, maxPerDay: MAX_POSTS_PER_DAY, windowDays: WINDOW_DAYS });
});

/**
 * POST /api/scheduled-posts/upload — media upload.
 * Accepts EITHER { mediaUrl } (an existing http(s) URL, returned as-is)
 * OR { fileBase64, fileName?, mimeType? } (base64 JSON upload; a data:
 * URL prefix is accepted too). Only image/* or video/*, max 25 MB.
 * Returns { url, mediaType, mimeType, sizeBytes }.
 *
 * Storage: on Vercel (BLOB_READ_WRITE_TOKEN set) the file goes to
 * Vercel Blob and `url` is its public Blob URL. Locally / on cPanel the
 * file goes to disk and `url` is /api/uploads/<file>. Large files
 * should use the direct browser→Blob path instead
 * (POST /scheduled-posts/upload-token + @vercel/blob/client), because
 * Vercel caps function request bodies at 4.5 MB.
 */
schedulingRouter.post('/scheduled-posts/upload', async (req: AuthRequest, res: Response) => {
  const { mediaUrl, fileBase64, fileName, mimeType } = (req.body ?? {}) as {
    mediaUrl?: string;
    fileBase64?: string;
    fileName?: string;
    mimeType?: string;
  };

  if (typeof mediaUrl === 'string' && mediaUrl.trim()) {
    let url: URL;
    try {
      url = new URL(mediaUrl.trim());
    } catch {
      res.status(400).json({ error: 'mediaUrl সঠিক লিংক নয় (invalid URL)' });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      res.status(400).json({ error: 'mediaUrl http(s) লিংক হতে হবে' });
      return;
    }
    const mediaType = inferMediaType([url.pathname]);
    res.status(201).json({
      url: url.toString(),
      mediaType,
      mimeType: typeof mimeType === 'string' ? mimeType : null,
      sizeBytes: null,
    });
    return;
  }

  if (typeof fileBase64 !== 'string' || fileBase64.trim() === '') {
    res.status(400).json({ error: 'fileBase64 বা mediaUrl — একটি দিতে হবে' });
    return;
  }
  let mime = typeof mimeType === 'string' ? mimeType.trim() : '';
  let b64 = fileBase64.trim();
  const dataUrlMatch = b64.match(/^data:([^;,]+);base64,(.+)$/);
  if (dataUrlMatch) {
    mime = dataUrlMatch[1];
    b64 = dataUrlMatch[2];
  }
  if (!/^(image|video)\//.test(mime)) {
    res.status(400).json({ error: 'শুধু ছবি (image/*) বা ভিডিও (video/*) আপলোড করা যায়' });
    return;
  }
  const ext = MIME_EXT[mime];
  if (!ext) {
    res.status(400).json({ error: `এই ফরম্যাট সাপোর্ট করা হয় না: ${mime}` });
    return;
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
    res.status(400).json({ error: 'fileBase64 সঠিক base64 নয়' });
    return;
  }
  const buf = Buffer.from(b64.replace(/\s/g, ''), 'base64');
  if (buf.length === 0) {
    res.status(400).json({ error: 'খালি ফাইল আপলোড করা যাবে না' });
    return;
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    res.status(400).json({ error: 'ফাইল 25 MB-এর বেশি হতে পারবে না (max 25 MB)' });
    return;
  }
  const stored = `${randomUUID()}${ext}`;
  const mediaType = mime.startsWith('video/') ? 'video' : 'image';
  // Vercel: store in Blob (public URL). The API function has a 4.5 MB
  // request-body cap, so large files should use the direct browser→Blob
  // path (/scheduled-posts/upload-token) instead — but small base64
  // uploads still work through here.
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const blob = await put(stored, buf, { access: 'public', contentType: mime });
      res.status(201).json({
        url: blob.url,
        mediaType,
        mimeType: mime,
        sizeBytes: buf.length,
        fileName: stored,
      });
      return;
    } catch (err) {
      res.status(500).json({ error: `ফাইল সংরক্ষণ করা যায়নি: ${(err as Error).message}` });
      return;
    }
  }
  // Local / cPanel fallback: disk storage under uploads/ (served at
  // /api/uploads/<file> by the static route above). Kept so local dev
  // and the existing verifiers keep working unchanged.
  try {
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  } catch (err) {
    res.status(500).json({ error: `ফাইল সংরক্ষণ করা যায়নি: ${(err as Error).message}` });
    return;
  }
  void fileName; // original name is not kept on disk (random UUID name instead)
  res.status(201).json({
    url: `/api/uploads/${stored}`,
    mediaType,
    mimeType: mime,
    sizeBytes: buf.length,
    fileName: stored,
  });
});

/**
 * POST /api/scheduled-posts/auto-caption { productIds?, topic?, lang?, mediaUrls? | mediaUrl? }
 * Drafts 2–3 caption options with the existing Groq helper, using the
 * products' REAL name / price / stock from the DB. Prices and stock are
 * NEVER invented — the prompt only gets DB values, and if the AI reply
 * does not contain a real price it is discarded in favour of template
 * captions built from the same DB values. Without an AI key (or on AI
 * failure) the templates are returned with aiGenerated: false.
 *
 * MEDIA-AWARE: when mediaUrls (or mediaUrl) is given, the attached
 * image/video is ANALYZED with Gemini vision first (see
 * ./media-caption.ts) and its caption — written from what is actually
 * in the media — is put first in the options, with `mediaAnalysis`
 * (what the AI saw) in the response. If vision fails (no key, fetch
 * failure, Gemini error) the endpoint falls back to the text-only
 * captions below and says so in `note` — an analysis is never faked.
 * Default language is Bengali; lang='en' gives English captions.
 */
schedulingRouter.post('/scheduled-posts/auto-caption', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { productIds, topic, lang, mediaUrls, mediaUrl } = (req.body ?? {}) as {
    productIds?: string[];
    topic?: string;
    lang?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
  };
  const english = lang === 'en';
  const mediaList = [
    ...(Array.isArray(mediaUrls) ? mediaUrls : []),
    ...(typeof mediaUrl === 'string' ? [mediaUrl] : []),
  ].filter((u) => typeof u === 'string' && u.trim());
  let products: { id: string; name: string; price_paisa: number; stock: number }[] = [];
  if (Array.isArray(productIds) && productIds.length > 0) {
    const { rows } = await query(
      workspaceId,
      `SELECT id, name, price_paisa, stock FROM products
       WHERE workspace_id = $1 AND id = ANY($2)`,
      [workspaceId, productIds],
    );
    products = rows as typeof products;
  }
  const taka = (paisa: number): number => Number(paisa) / 100;
  const productBits = products
    .map((p) => `${p.name} ৳${taka(Number(p.price_paisa))}`)
    .join(', ');
  const stockBits = products
    .filter((p) => Number(p.stock) > 0)
    .map((p) => `${p.name}: ${p.stock}টি`)
    .join(', ');
  const topicText = typeof topic === 'string' && topic.trim() ? topic.trim() : '';

  const templates: string[] = (() => {
    if (products.length === 0) {
      const subject = topicText || (english ? 'our new collection' : 'আমাদের নতুন কালেকশন');
      return english
        ? [
            `✨ ${subject} is here! Inbox us to order 📩 #onlineshop #bangladesh`,
            `🛍️ ${subject} — limited stock! Order now before it runs out 🚚 Delivery all over Bangladesh.`,
            `💥 ${subject}! Send your name, address and phone number in the inbox to confirm your order ✅`,
          ]
        : [
            `✨ ${subject} চলে এসেছে! অর্ডার করতে ইনবক্স করুন 📩 #অনলাইনশপ #বাংলাদেশ`,
            `🛍️ ${subject} — স্টক সীমিত! শেষ হওয়ার আগেই অর্ডার করুন 🚚 সারা দেশে ডেলিভারি।`,
            `💥 ${subject}! অর্ডার কনফার্ম করতে নাম, ঠিকানা ও ফোন নম্বর ইনবক্স করুন ✅`,
          ];
    }
    const stockLine = stockBits
      ? english
        ? ` In stock: ${stockBits}.`
        : ` স্টকে আছে: ${stockBits}।`
      : '';
    return english
      ? [
          `🛍️ ${productBits}!${stockLine} Inbox us to order 📩 #onlineshop #bangladesh`,
          `✨ New collection! ${productBits} — limited stock, order now! 🚚 Delivery all over Bangladesh.`,
          `💥 Offer! ${productBits}${stockLine} Send your name, address and phone number in the inbox to confirm ✅`,
        ]
      : [
          `🛍️ ${productBits}!${stockLine} অর্ডার করতে ইনবক্স করুন 📩 #অনলাইনশপ #বাংলাদেশ`,
          `✨ নতুন কালেকশন! ${productBits} — স্টক সীমিত, তাড়াতাড়ি অর্ডার করুন! 🚚 সারা দেশে ডেলিভারি।`,
          `💥 অফার! ${productBits}${stockLine} অর্ডার কনফার্ম করতে নাম, ঠিকানা ও ফোন নম্বর ইনবক্স করুন ✅`,
        ];
  })();

  const priceStrings = products.map((p) => String(taka(Number(p.price_paisa))));
  const containsRealPrice = (text: string): boolean =>
    products.length === 0 || priceStrings.some((s) => text.includes(s));

  // Media-aware caption: if media is attached, analyze the FIRST item
  // with Gemini vision and put its caption first. Any vision failure
  // falls back to the text-only captions below (with a note) — the
  // analysis is never faked.
  let mediaCaption: string | null = null;
  let mediaAnalysis: { analysis: string; mediaType: 'image' | 'video' } | null = null;
  let visionNote: string | null = null;
  if (mediaList.length > 0) {
    const productContext =
      products.length > 0
        ? products
            .map((p) => `${p.name}, ৳${taka(Number(p.price_paisa))}, stock ${p.stock}`)
            .join('; ')
        : undefined;
    try {
      const analyzed = await analyzePostMedia({
        mediaUrl: mediaList[0],
        lang: english ? 'en' : 'bn',
        productContext,
      });
      mediaCaption = analyzed.caption;
      // Price guard: a linked product's real price must appear in the
      // caption — append it truthfully if the vision caption missed it.
      if (!containsRealPrice(mediaCaption)) {
        mediaCaption += english
          ? `\nPrice: ${productBits}`
          : `\nদাম: ${productBits}`;
      }
      mediaAnalysis = { analysis: analyzed.analysis, mediaType: analyzed.mediaType };
    } catch (err) {
      visionNote = (err as Error).message;
      console.error('[scheduling] auto-caption vision failed, using text captions:', visionNote);
    }
  }

  // Text-only captions (Groq, or DB-truthful templates on failure).
  let groqOptions: string[] | null = null;
  try {
    const context =
      products.length > 0
        ? english
          ? `Products (use ONLY these real values — never invent a price or stock): ${products
              .map((p) => `${p.name}, price ৳${taka(Number(p.price_paisa))}, stock ${p.stock}`)
              .join('; ')}`
          : `প্রোডাক্ট (শুধু এই আসল তথ্যই ব্যবহার করো — দাম বা স্টক বানিয়ে লিখো না): ${products
              .map((p) => `${p.name}, দাম ৳${taka(Number(p.price_paisa))}, স্টক ${p.stock}টি`)
              .join('; ')}`
        : english
          ? `Topic: ${topicText || 'new collection'}. No specific product — do not invent any price or stock.`
          : `বিষয়: ${topicText || 'নতুন কালেকশন'}। কোনো নির্দিষ্ট প্রোডাক্ট নেই — দাম বা স্টক বানিয়ে লিখো না।`;
    const prompt = english
      ? `Write exactly 3 different Facebook/Instagram post captions (2-3 lines each, with 3-5 hashtags at the end). Each caption MUST include the real product price from below. Number them 1. 2. 3. on separate lines.\n${context}`
      : `ফেসবুক/ইনস্টাগ্রাম পোস্টের জন্য ঠিক ৩টি আলাদা ক্যাপশন লেখো (প্রতিটি ২-৩ লাইন, শেষে ৩-৫টি হ্যাশট্যাগ)। প্রতিটি ক্যাপশনে নিচের আসল প্রোডাক্টের দাম অবশ্যই লিখতে হবে। 1. 2. 3. নম্বর দিয়ে আলাদা লাইনে লেখো।\n${context}`;
    const result = await callGroq(prompt);
    if (result?.text) {
      let text = result.text.trim();
      try {
        const parsed = JSON.parse(text) as { reply?: string };
        if (parsed.reply) text = parsed.reply.trim();
      } catch {
        // Plain-text reply from the model — use it as-is.
      }
      const options = text
        .split(/\n+/)
        .map((line) => line.replace(/^\s*(?:\d+[.)]\s*|[-•*]\s*)/, '').trim())
        .filter((line) => line.length >= 10)
        // Drop hashtag-only lines (the model's trailing hashtag block
        // is not a caption on its own).
        .filter((line) => line.replace(/#\S+/g, '').trim().length > 0)
        .filter((line, i, arr) => arr.indexOf(line) === i)
        .slice(0, 3);
      if (options.length >= 2 && options.some(containsRealPrice)) {
        groqOptions = [...options];
        while (groqOptions.length < 3) {
          const extra = templates.find((t) => !groqOptions!.includes(t));
          if (!extra) break;
          groqOptions.push(extra);
        }
        groqOptions = groqOptions.slice(0, 3);
      }
      // AI reply did not carry a real price (or too few options) — fall
      // through to the DB-truthful templates instead of inventing one.
    }
  } catch (err) {
    console.error('[scheduling] auto-caption AI failed, using templates:', (err as Error).message);
  }
  // Compose: media caption first (when vision succeeded), then the
  // Groq/template options, de-duplicated, max 3.
  const baseOptions = groqOptions ?? templates.slice(0, 3);
  const composed: string[] = [];
  if (mediaCaption) composed.push(mediaCaption);
  for (const opt of baseOptions) {
    if (composed.length >= 3) break;
    if (!composed.includes(opt)) composed.push(opt);
  }
  const aiGenerated = mediaCaption !== null || groqOptions !== null;
  res.json({
    options: composed.slice(0, 3),
    aiGenerated,
    ...(mediaAnalysis ? { mediaAnalysis } : {}),
    ...(!aiGenerated
      ? {
          note: english
            ? 'AI key is not set or the AI did not answer, so template captions built from your real product data are shown — no price/stock was invented.' +
              (visionNote ? ` The attached media could not be analyzed (${visionNote}).` : '')
            : 'AI চাবি বসানো নেই বা AI উত্তর দিচ্ছে না, তাই আপনার আসল প্রোডাক্টের তথ্য দিয়ে সাধারণ ক্যাপশন দেওয়া হলো — দাম/স্টক বানিয়ে লেখা হয়নি।' +
              (visionNote ? ` সংযুক্ত ছবি/ভিডিও বিশ্লেষণ করা যায়নি (${visionNote})।` : ''),
        }
      : visionNote
        ? {
            note: english
              ? `The attached media could not be analyzed (${visionNote}), so text captions are shown instead.`
              : `সংযুক্ত ছবি/ভিডিও বিশ্লেষণ করা যায়নি (${visionNote}), তাই সাধারণ ক্যাপশন দেওয়া হলো।`,
          }
        : {}),
  });
});

/** GET /api/scheduled-posts/:id */
schedulingRouter.get('/scheduled-posts/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const post = await loadPost(workspaceId, req.params.id);
  if (!post) {
    res.status(404).json({ error: 'Scheduled post not found' });
    return;
  }
  const products = await loadPostProducts(workspaceId, post.id);
  const errors = await lastErrors(workspaceId, [post.id]);
  res.json({ post: withLastErrors([post], errors)[0], products });
});

/** POST /api/scheduled-posts — draft unless scheduledAt is given, then scheduled. */
schedulingRouter.post('/scheduled-posts', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { caption, mediaUrls, mediaType, platforms, scheduledAt, productIds } = (req.body ?? {}) as PostBody;
  const media = Array.isArray(mediaUrls) ? mediaUrls.filter((u) => typeof u === 'string') : [];
  const plats = Array.isArray(platforms)
    ? platforms.filter((p) => typeof p === 'string' && p.trim() !== '').map((p) => p.toLowerCase())
    : [];
  if ((!caption || !caption.trim()) && media.length === 0) {
    res.status(400).json({ error: 'caption বা ছবি/ভিডিও — অন্তত একটি লাগবে' });
    return;
  }
  if (plats.length === 0) {
    res.status(400).json({ error: 'অন্তত একটি প্ল্যাটফর্ম বেছে নিন (facebook)' });
    return;
  }
  // Only Facebook can actually publish (see publisher.ts) — Instagram /
  // TikTok publishing is not built yet, and Messenger/WhatsApp are message
  // channels, never post platforms. Reject them here instead of letting a
  // post sit in 'failed' after its scheduled time.
  const unsupported = plats.filter((p) => p !== 'facebook');
  if (unsupported.length > 0) {
    res.status(400).json({
      error: `Only Facebook posts can be published right now — ${unsupported.join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} coming soon. (এখন শুধু ফেসবুক পোস্ট প্রকাশ করা যায় — ${unsupported.join(', ')} শীঘ্রই আসছে।)`,
    });
    return;
  }
  if (scheduledAt !== undefined && scheduledAt !== null && !isValidDate(scheduledAt)) {
    res.status(400).json({ error: 'scheduledAt সঠিক তারিখ নয়' });
    return;
  }
  let mt: MediaType = inferMediaType(media);
  if (mediaType !== undefined) {
    if (!isValidMediaType(mediaType)) {
      res.status(400).json({ error: "mediaType হতে হবে image, video বা text" });
      return;
    }
    mt = mediaType;
  }
  if (mt === 'video' && media.length === 0) {
    res.status(400).json({ error: 'ভিডিও পোস্টে ভিডিও লাগবে (video post needs a video)' });
    return;
  }
  if (mt === 'image' && media.length === 0) {
    res.status(400).json({ error: 'ছবির পোস্টে ছবি লাগবে (image post needs an image)' });
    return;
  }
  const status = scheduledAt ? 'scheduled' : 'draft';
  if (status === 'scheduled' && scheduledAt) {
    const winErr = windowError(scheduledAt);
    if (winErr) {
      res.status(400).json({ error: winErr });
      return;
    }
    try {
      const slotErr = await assertSlotFree(workspaceId, scheduledAt);
      if (slotErr) {
        res.status(400).json({ error: slotErr });
        return;
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
      return;
    }
  }
  try {
    const { rows } = await query<ScheduledPostRow>(
      workspaceId,
      `INSERT INTO scheduled_posts (workspace_id, caption, media_urls, media_type, platforms, scheduled_at, status)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7) RETURNING ${POST_COLUMNS}`,
      [
        workspaceId,
        caption?.trim() || null,
        JSON.stringify(media),
        mt,
        plats,
        scheduledAt ?? null,
        status,
      ],
    );
    const post = rows[0];
    if (Array.isArray(productIds) && productIds.length > 0) {
      await attachProducts(workspaceId, post.id, productIds);
    }
    if (status === 'scheduled' && scheduledAt) {
      // Best-effort: a failed enqueue only means the polling sweep picks it up.
      await enqueueScheduledPost(post.id, scheduledAt, workspaceId).catch(() => undefined);
    }
    res.status(201).json({ post });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** PATCH /api/scheduled-posts/:id — caption/mediaUrls/mediaType/scheduledAt/status (cancel via status 'cancelled'). */
schedulingRouter.patch('/scheduled-posts/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { caption, mediaUrls, mediaType, scheduledAt, status } = (req.body ?? {}) as {
    caption?: string;
    mediaUrls?: string[];
    mediaType?: string;
    scheduledAt?: string | null;
    status?: string;
  };
  const post = await loadPost(workspaceId, req.params.id);
  if (!post) {
    res.status(404).json({ error: 'Scheduled post not found' });
    return;
  }
  if (status !== undefined && !['draft', 'scheduled', 'cancelled'].includes(status)) {
    res.status(400).json({ error: "status হতে হবে draft, scheduled বা cancelled" });
    return;
  }
  if (mediaType !== undefined && !isValidMediaType(mediaType)) {
    res.status(400).json({ error: "mediaType হতে হবে image, video বা text" });
    return;
  }
  const newScheduledAt =
    scheduledAt === undefined ? post.scheduled_at : (scheduledAt ?? null);
  const newStatus = status ?? post.status;
  if (newStatus === 'scheduled' && !newScheduledAt) {
    res.status(400).json({ error: 'শিডিউল করতে scheduledAt লাগবে' });
    return;
  }
  if (scheduledAt !== undefined && scheduledAt !== null && !isValidDate(scheduledAt)) {
    res.status(400).json({ error: 'scheduledAt সঠিক তারিখ নয়' });
    return;
  }
  if (newStatus === 'scheduled' && newScheduledAt) {
    const winErr = windowError(newScheduledAt);
    if (winErr) {
      res.status(400).json({ error: winErr });
      return;
    }
    // Only re-check the slot when the post is (re-)scheduled or moves day.
    if (post.status !== 'scheduled' || post.scheduled_at !== newScheduledAt) {
      try {
        const slotErr = await assertSlotFree(workspaceId, newScheduledAt, post.id);
        if (slotErr) {
          res.status(400).json({ error: slotErr });
          return;
        }
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
        return;
      }
    }
  }
  const media = mediaUrls === undefined ? null : JSON.stringify(mediaUrls.filter((u) => typeof u === 'string'));
  const { rows } = await query<ScheduledPostRow>(
    workspaceId,
    `UPDATE scheduled_posts
     SET caption = COALESCE($1, caption),
         media_urls = COALESCE($2::jsonb, media_urls),
         media_type = COALESCE($3, media_type),
         scheduled_at = $4,
         status = COALESCE($5, status),
         updated_at = now()
     WHERE workspace_id = $6 AND id = $7 RETURNING ${POST_COLUMNS}`,
    [
      caption?.trim() || null,
      media,
      mediaType ?? null,
      newScheduledAt,
      status ?? null,
      workspaceId,
      req.params.id,
    ],
  );
  const updated = rows[0];
  if (updated.status === 'scheduled' && updated.scheduled_at) {
    await enqueueScheduledPost(updated.id, updated.scheduled_at, workspaceId).catch(() => undefined);
  }
  res.json({ post: updated });
});

/** DELETE /api/scheduled-posts/:id — draft only. */
schedulingRouter.delete('/scheduled-posts/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const post = await loadPost(workspaceId, req.params.id);
  if (!post) {
    res.status(404).json({ error: 'Scheduled post not found' });
    return;
  }
  if (post.status !== 'draft') {
    res.status(400).json({ error: 'শুধু খসড়া (draft) পোস্ট মুছে ফেলা যায়; শিডিউল করা পোস্ট বাতিল করুন' });
    return;
  }
  await query(
    workspaceId,
    'DELETE FROM post_products WHERE workspace_id = $1 AND scheduled_post_id = $2',
    [workspaceId, post.id],
  );
  await query(
    workspaceId,
    'DELETE FROM scheduled_posts WHERE workspace_id = $1 AND id = $2',
    [workspaceId, post.id],
  );
  res.json({ deleted: true });
});

/** POST /api/scheduled-posts/:id/schedule {scheduledAt} */
schedulingRouter.post('/scheduled-posts/:id/schedule', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { scheduledAt } = (req.body ?? {}) as { scheduledAt?: string };
  if (!isValidDate(scheduledAt)) {
    res.status(400).json({ error: 'scheduledAt সঠিক তারিখ নয়' });
    return;
  }
  const winErr = windowError(scheduledAt as string);
  if (winErr) {
    res.status(400).json({ error: winErr });
    return;
  }
  const post = await loadPost(workspaceId, req.params.id);
  if (!post) {
    res.status(404).json({ error: 'Scheduled post not found' });
    return;
  }
  if (post.status === 'cancelled' || post.status === 'published') {
    res.status(400).json({ error: 'এই পোস্টটি আর শিডিউল করা যায় না' });
    return;
  }
  const slotErr = await assertSlotFree(workspaceId, scheduledAt as string, post.id).catch(
    (err: Error) => {
      res.status(500).json({ error: err.message });
      return '__error__';
    },
  );
  if (slotErr === '__error__') return;
  if (slotErr) {
    res.status(400).json({ error: slotErr });
    return;
  }
  const { rows } = await query<ScheduledPostRow>(
    workspaceId,
    `UPDATE scheduled_posts SET scheduled_at = $1, status = 'scheduled', updated_at = now()
     WHERE workspace_id = $2 AND id = $3 RETURNING ${POST_COLUMNS}`,
    [scheduledAt, workspaceId, req.params.id],
  );
  await enqueueScheduledPost(rows[0].id, scheduledAt as string, workspaceId).catch(() => undefined);
  res.json({ post: rows[0] });
});

/** POST /api/scheduled-posts/:id/publish-now — publishing frees the day's slot. */
schedulingRouter.post('/scheduled-posts/:id/publish-now', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const post = await loadPost(workspaceId, req.params.id);
  if (!post) {
    res.status(404).json({ error: 'Scheduled post not found' });
    return;
  }
  try {
    const published = await publishScheduledPost(workspaceId, post.id);
    res.json({ post: published });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** POST /api/scheduled-posts/:id/attach-product {productId} */
schedulingRouter.post('/scheduled-posts/:id/attach-product', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { productId } = (req.body ?? {}) as { productId?: string };
  if (!productId) {
    res.status(400).json({ error: 'productId is required' });
    return;
  }
  const post = await loadPost(workspaceId, req.params.id);
  if (!post) {
    res.status(404).json({ error: 'Scheduled post not found' });
    return;
  }
  try {
    await attachProducts(workspaceId, post.id, [productId]);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const { rows } = await query(
    workspaceId,
    `SELECT id, scheduled_post_id, product_id, created_at FROM post_products
     WHERE workspace_id = $1 AND scheduled_post_id = $2 AND product_id = $3`,
    [workspaceId, post.id, productId],
  );
  res.status(201).json({ postProduct: rows[0] });
});

/** DELETE /api/scheduled-posts/:id/products/:productId */
schedulingRouter.delete('/scheduled-posts/:id/products/:productId', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rowCount } = await query(
    workspaceId,
    `DELETE FROM post_products
     WHERE workspace_id = $1 AND scheduled_post_id = $2 AND product_id = $3`,
    [workspaceId, req.params.id, req.params.productId],
  );
  if (rowCount === 0) {
    res.status(404).json({ error: 'Post product not found' });
    return;
  }
  res.json({ deleted: true });
});

/**
 * POST /api/scheduled-posts/:id/ai-caption {productIds?}
 * Bengali caption + hashtags from the post caption / product names.
 * Prices and stock are NEVER invented — the prompt tells the AI to use
 * only the names given here. Without an AI key, a plain template caption
 * is returned and the response says so (aiGenerated: false).
 */
schedulingRouter.post('/scheduled-posts/:id/ai-caption', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { productIds } = (req.body ?? {}) as { productIds?: string[] };
  const post = await loadPost(workspaceId, req.params.id);
  if (!post) {
    res.status(404).json({ error: 'Scheduled post not found' });
    return;
  }
  let products = await loadPostProducts(workspaceId, post.id);
  if (Array.isArray(productIds) && productIds.length > 0) {
    const { rows } = await query(
      workspaceId,
      `SELECT id, name, price_paisa, stock FROM products
       WHERE workspace_id = $1 AND id = ANY($2)`,
      [workspaceId, productIds],
    );
    products = rows;
  }
  const productNames = products.map((p) => p.name as string).filter(Boolean);
  const context =
    productNames.length > 0
      ? `প্রোডাক্ট: ${productNames.join(', ')}`
      : 'কোনো নির্দিষ্ট প্রোডাক্ট নেই';
  const templateCaption = [
    post.caption?.trim() || '',
    productNames.length > 0 ? `🛍️ ${productNames.join(', ')}` : '',
    '#অনলাইনশপ #বাংলাদেশ',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await callGroq(
      `একটি ফেসবুক/ইনস্টাগ্রাম পোস্টের জন্য বাংলায় আকর্ষণীয় ক্যাপশন লেখো (২-৩ লাইন) এবং শেষে ৩-৫টি হ্যাশট্যাগ দাও। ` +
        `দাম, স্টক বা ছাড় বানিয়ে লিখো না — শুধু নিচের তথ্য ব্যবহার করো।\n` +
        `পোস্টের লেখা: ${post.caption ?? '(খালি)'}\n${context}`,
    );
    if (result) {
      let caption = result.text.trim();
      try {
        const parsed = JSON.parse(caption) as { reply?: string };
        if (parsed.reply) caption = parsed.reply.trim();
      } catch {
        // Plain-text reply from the model — use it as-is.
      }
      res.json({ caption, aiGenerated: true });
      return;
    }
  } catch (err) {
    console.error('[scheduling] AI caption failed, using template:', (err as Error).message);
  }
  res.json({
    caption: templateCaption,
    aiGenerated: false,
    note: 'AI চাবি বসানো নেই বা AI উত্তর দিচ্ছে না, তাই সাধারণ ক্যাপশন দেওয়া হলো — দাম/স্টক বানিয়ে লেখা হয়নি।',
  });
});
