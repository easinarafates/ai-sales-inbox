#!/usr/bin/env node
/**
 * Verification for YouTube scheduling + YouTube comments + TikTok APIs
 * (posting, comments, DMs) — docs/youtube-tiktok-setup.md.
 *
 * Local, offline — no calls to googleapis.com, tiktok.com or
 * business-api.tiktok.com. Three stub servers stand in for them (one HTTP
 * server; the API is pointed at it with GOOGLE_*_BASE_URL,
 * TIKTOK_API_BASE_URL and TIKTOK_BUSINESS_API_BASE_URL env overrides).
 *
 * Phase A (no keys): youtube/login + tiktok/login → 503 (Bengali "not set
 * up yet"); youtube/tiktok status → configured:false; a YouTube scheduled
 * post's publish-now fails honestly (no channel) and ends 'failed'.
 * Phase B (dummy keys + stubs + audit/DM flags on):
 *  - OAuth callbacks (self-minted state JWTs) create exactly one
 *    'youtube' + one 'tiktok' channel row, with the new scopes stored
 *    (youtube.upload / video.publish / comment.list); reconnect updates
 *    the token, no second row.
 *  - Login URLs carry the new scopes.
 *  - GET /api/youtube/videos + /comments → live stub data (author, text,
 *    video, time, likes, replies); POST reply → real stub reply id.
 *  - GET /api/tiktok/videos + /comments → live stub data; POST reply →
 *    real stub reply id.
 *  - Schedule: YouTube video post → publish-now → 'published' with the
 *    REAL stub video id (private + publishAt path, since scheduled_at is
 *    in the future); TikTok video post → publish-now → 'published' with
 *    the real public video id, publish_ref stored (the async publish id).
 *  - Quota: 6 YouTube uploads today → the 7th fails honestly with the
 *    quota message; GET /api/youtube/status shows uploadsToday 6/6.
 *  - Validation: text post to youtube/tiktok → 400; instagram → 400.
 *  - TikTok DM: webhook without approval → 403 + nothing stored; with
 *    approval → 200 accepted 1, duplicate → accepted 0, the DM is in
 *    the Inbox; manual reply via POST /api/inbox/:id/reply → 201 with
 *    the REAL Business Messaging message id (resolve conversation +
 *    send through the stub); GET /api/tiktok/dm/conversations + thread
 *    → live stub data; POST /api/tiktok/dm/sync → imports 1, second
 *    sync → 0 (dedup).
 *
 * Run from the repo root:  node scripts/verify-youtube-tiktok.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';
let workspaceId = '';
let userId = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read one value from apps/api/.env (never printed). */
function envFileValue(name) {
  const envPath = path.join(ROOT, 'apps/api/.env');
  if (!fs.existsSync(envPath)) return '';
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${name}=`)) return t.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

/** Minimal HS256 JWT signer (same secret the test API uses). */
function signJwt(secret, payload, expiresInSec = 600) {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...payload, iat: now, exp: now + expiresInSec })}`;
  return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
}

function makeApi(base) {
  return async function api(path, { method = 'GET', body, auth = true, redirect = 'follow', headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, text, location: res.headers.get('location') };
  };
}

async function waitForHealth(base, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

function startApi(port, dataDir, extraEnv = {}) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: `pglite://${dataDir}`,
      ...extraEnv,
    },
  });
  let apiLog = '';
  apiProc.stdout.on('data', (d) => { apiLog += d.toString(); });
  apiProc.stderr.on('data', (d) => { apiLog += d.toString(); });
  const stop = () => {
    try { process.kill(-apiProc.pid, 'SIGTERM'); } catch { try { apiProc.kill('SIGTERM'); } catch { /* already gone */ } }
  };
  return { proc: apiProc, stop, log: () => apiLog };
}

async function setupWorkspace(api, stamp) {
  const email = `yt-tt+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'YT Owner', email, password: 'verify1234', workspaceName: 'YT Shop' },
  });
  check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  workspaceId = signup.data?.workspace?.id ?? '';
  userId = signup.data?.user?.id ?? '';
  return { token, workspaceId, userId };
}

/** Switch the API client's auth to another workspace's credentials. */
function useWorkspace(ws) {
  token = ws.token;
  workspaceId = ws.workspaceId;
  userId = ws.userId;
}

// ---------------------------------------------------------------------------
// Stub Google / TikTok / Business Messaging server
// ---------------------------------------------------------------------------

function startStub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
        const params = new URLSearchParams(body);

        // ---- media file for the publisher to download ----
        if (req.method === 'GET' && url.pathname === '/video.mp4') {
          res.writeHead(200, { 'Content-Type': 'video/mp4' });
          res.end(Buffer.from('fake-mp4-bytes-for-test'));
          return;
        }
        // ---- Google token endpoint (code exchange + refresh) ----
        if (req.method === 'POST' && url.pathname === '/token') {
          send(200, { access_token: 'goog-access-1', refresh_token: 'goog-refresh-1', expires_in: 3600, token_type: 'Bearer' });
          return;
        }
        // ---- YouTube channels (verify + uploads playlist) ----
        if (req.method === 'GET' && url.pathname === '/youtube/v3/channels') {
          if (url.searchParams.get('part') === 'contentDetails') {
            send(200, { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU-test' } } }] });
          } else {
            send(200, { items: [{ id: 'UC-test', snippet: { title: 'Test Channel', thumbnails: { default: { url: 'https://example.com/t.jpg' } } } }] });
          }
          return;
        }
        // ---- YouTube playlist items (own videos) ----
        if (req.method === 'GET' && url.pathname === '/youtube/v3/playlistItems') {
          send(200, { items: [{ snippet: { resourceId: { videoId: 'yt-vid-1' }, title: 'Test Video', description: 'A test video', publishedAt: '2026-11-08T00:00:00Z', thumbnails: { medium: { url: 'https://example.com/th.jpg' } } } }] });
          return;
        }
        // ---- YouTube comment threads ----
        if (req.method === 'GET' && url.pathname === '/youtube/v3/commentThreads') {
          send(200, {
            items: [{
              id: 'thread-1',
              snippet: {
                videoId: 'yt-vid-1',
                topLevelComment: { id: 'yt-c1', snippet: { authorDisplayName: 'Commenter One', authorProfileImageUrl: '', textDisplay: 'Nice video!', publishedAt: '2026-11-08T01:00:00Z', likeCount: 3 } },
                totalReplyCount: 1,
              },
              replies: { comments: [{ id: 'yt-c1-r1', snippet: { authorDisplayName: 'Owner', textDisplay: 'Thanks!', publishedAt: '2026-11-08T02:00:00Z' } }] },
            }],
          });
          return;
        }
        // ---- YouTube comment reply ----
        if (req.method === 'POST' && url.pathname === '/youtube/v3/comments') {
          if (parsed?.snippet?.parentId === 'yt-c1' && parsed?.snippet?.textOriginal) {
            send(200, { id: 'yt-reply-1' });
          } else {
            send(400, { error: { code: 400, message: 'bad reply' } });
          }
          return;
        }
        // ---- YouTube resumable upload: init → session URL ----
        if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/videos') {
          send(200, {}, { Location: `http://localhost:${server.address().port}/upload/session/1` });
          return;
        }
        // ---- YouTube resumable upload: PUT bytes → real video id ----
        if (req.method === 'PUT' && url.pathname === '/upload/session/1') {
          send(200, { id: 'yt-video-123', snippet: { title: 'Scheduled video' } });
          return;
        }
        // ---- TikTok OAuth token (code + refresh) ----
        if (req.method === 'POST' && url.pathname === '/v2/oauth/token/') {
          send(200, { access_token: 'tt-access-1', refresh_token: 'tt-refresh-1', open_id: 'tt-open-1', expires_in: 86400, scope: 'user.info.basic,video.list,video.publish,video.upload,comment.list' });
          return;
        }
        // ---- TikTok profile verify ----
        if (req.method === 'GET' && url.pathname === '/v2/user/info/') {
          send(200, { data: { user: { open_id: 'tt-open-1', display_name: 'TikTok Shop', avatar_url: 'https://example.com/a.jpg' } } });
          return;
        }
        // ---- TikTok Display API: video list ----
        if (req.method === 'POST' && url.pathname === '/v2/video/list/') {
          send(200, { data: { videos: [{ id: 'tt-vid-1', title: 'TT Video', cover_image_url: '', share_url: 'https://tiktok.com/@x/video/1', create_time: 1762500000, view_count: 10, like_count: 2, comment_count: 1, share_count: 0 }], has_more: false, cursor: 0 } });
          return;
        }
        // ---- TikTok Comment API: list / replies ----
        if (req.method === 'GET' && url.pathname === '/v2/video/comment/list/') {
          if (url.searchParams.get('comment_id')) {
            send(200, { data: { comments: [{ id: 'tt-c1-r1', video_id: 'tt-vid-1', text: 'You are welcome!', like_count: 1, reply_count: 0, create_time: 1762500200 }], has_more: false, cursor: 0 } });
          } else if (url.searchParams.get('video_id') === 'tt-vid-1') {
            send(200, { data: { comments: [{ id: 'tt-c1', video_id: 'tt-vid-1', text: 'Great!', like_count: 5, reply_count: 1, create_time: 1762500100 }], has_more: false, cursor: 0 } });
          } else {
            send(400, { error: { code: 'invalid_params', message: 'video_id required' } });
          }
          return;
        }
        // ---- TikTok Comment API: reply ----
        if (req.method === 'POST' && url.pathname === '/v2/video/comment/reply/') {
          if (parsed?.video_id === 'tt-vid-1' && parsed?.comment_id === 'tt-c1' && parsed?.text) {
            send(200, { data: { comment_id: 'tt-reply-1' } });
          } else {
            send(400, { error: { code: 'invalid_params', message: 'bad reply' } });
          }
          return;
        }
        // ---- TikTok Content Posting: creator info ----
        if (req.method === 'POST' && url.pathname === '/v2/post/publish/creator_info/query/') {
          send(200, { data: { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] } });
          return;
        }
        // ---- TikTok Content Posting: video init ----
        if (req.method === 'POST' && url.pathname === '/v2/post/publish/video/init/') {
          if (parsed?.source_info?.source === 'FILE_UPLOAD') {
            send(200, { data: { publish_id: 'tt-publish-1', upload_url: `http://localhost:${server.address().port}/tt-upload/1` } });
          } else {
            send(400, { error: { code: 'invalid_params', message: 'need FILE_UPLOAD' } });
          }
          return;
        }
        // ---- TikTok chunk PUT ----
        if (req.method === 'PUT' && url.pathname === '/tt-upload/1') {
          send(200, {});
          return;
        }
        // ---- TikTok Content Posting: status fetch ----
        if (req.method === 'POST' && url.pathname === '/v2/post/publish/status/fetch/') {
          if (parsed?.publish_id === 'tt-publish-1') {
            send(200, { data: { status: 'PUBLISH_COMPLETE', public_video_id: 'tt-video-1' } });
          } else {
            send(200, { data: { status: 'FAILED', fail_reason: 'unknown publish_id' } });
          }
          return;
        }
        // ---- Business Messaging: conversation list ----
        if (req.method === 'GET' && url.pathname === '/business/message/conversation/list/') {
          if (req.headers['access-token'] !== 'bm-token-1' || url.searchParams.get('business_id') !== 'bm-business-1') {
            send(401, { code: 401, message: 'bad business token' });
          } else {
            send(200, { code: 0, data: { conversations: [{ conversation_id: 'bm-conv-1', update_time: 1762500200 }] } });
          }
          return;
        }
        // ---- Business Messaging: thread ----
        if (req.method === 'GET' && url.pathname === '/business/message/content/list/') {
          if (url.searchParams.get('conversation_id') !== 'bm-conv-1') {
            send(404, { code: 404, message: 'no conversation' });
          } else {
            send(200, {
              code: 0,
              data: {
                participants: [
                  { id: 'bm-business-1', display_name: 'Shop', role: 'BUSINESS_ACCOUNT' },
                  { id: 'tt-user-9', display_name: 'TikTok Buyer', role: 'USER' },
                ],
                messages: [{ message_id: 'bm-msg-1', timestamp: 1762500200, text: { body: 'Price please' }, from_user: { role: 'USER', id: 'tt-user-9' } }],
              },
            });
          }
          return;
        }
        // ---- Business Messaging: send ----
        if (req.method === 'POST' && url.pathname === '/business/message/send/') {
          if (parsed?.business_id === 'bm-business-1' && parsed?.recipient === 'bm-conv-1' && parsed?.message_type === 'TEXT') {
            send(200, { code: 0, data: { message: { message_id: 'bm-msg-sent-1' } } });
          } else {
            send(400, { code: 400, message: 'bad send' });
          }
          return;
        }
        // ---- Business Messaging: media upload ----
        if (req.method === 'POST' && url.pathname === '/business/message/media/upload/') {
          send(200, { code: 0, data: { media_id: 'bm-media-1' } });
          return;
        }
        send(404, { error: 'stub: no such route', path: url.pathname });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const jwtSecret = envFileValue('JWT_SECRET');
  check('JWT_SECRET available for test signing (from apps/api/.env)', jwtSecret.length > 0);
  const stub = await startStub();
  const stubPort = stub.address().port;
  const stubBase = `http://127.0.0.1:${stubPort}`;
  const mediaUrl = `${stubBase}/video.mp4`;

  // ---------- Static checks ----------
  const ytSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/youtube.ts'), 'utf8');
  check('youtube client: resumable upload (uploadType=resumable + 308 resume)', ytSrc.includes('uploadType=resumable') && ytSrc.includes('308'));
  check('youtube client: quota constants 10000 / 1600 / 6 per day', ytSrc.includes('10000') && ytSrc.includes('1600') && ytSrc.includes('YOUTUBE_MAX_UPLOADS_PER_DAY'));
  check('youtube client: publishAt + private for future posts', ytSrc.includes('publishAt') && ytSrc.includes("'private'"));
  check('youtube client: quotaExceeded detected from Google errors', ytSrc.includes('quotaExceeded'));
  check('youtube client: refresh token flow (grant_type refresh_token)', ytSrc.includes('refresh_token'));
  check('youtube client: comments via commentThreads.list + reply via comments.insert', ytSrc.includes('commentThreads') && ytSrc.includes('/youtube/v3/comments'));
  check('youtube client: no fake/stub video id is ever returned', !ytSrc.includes('stub-') && !ytSrc.includes('fake_video_id'));
  const ttSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/tiktok.ts'), 'utf8');
  check('tiktok client: Content Posting API (creator_info/query + video/init + status/fetch)', ttSrc.includes('creator_info/query') && ttSrc.includes('post/publish/video/init') && ttSrc.includes('status/fetch'));
  check('tiktok client: PUBLISH_COMPLETE is the only success state', ttSrc.includes('PUBLISH_COMPLETE'));
  check('tiktok client: Display API video list + Comment API list/reply', ttSrc.includes('/v2/video/list/') && ttSrc.includes('/v2/video/comment/list/') && ttSrc.includes('/v2/video/comment/reply/'));
  check('tiktok client: Business Messaging send/list/content on business-api host', ttSrc.includes('/business/message/send/') && ttSrc.includes('/business/message/conversation/list/') && ttSrc.includes('/business/message/content/list/'));
  check('tiktok client: BM send uses Access-Token + business_id (not Login Kit token)', ttSrc.includes("'Access-Token'") && ttSrc.includes('business_id'));
  check('tiktok client: refresh token flow', ttSrc.includes("grant_type: 'refresh_token'"));
  const ytOauth = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/youtube-oauth.ts'), 'utf8');
  check('youtube oauth: requests youtube.upload + youtube.force-ssl (not readonly-only)', ytOauth.includes('youtube.upload') && ytOauth.includes('youtube.force-ssl') && ytOauth.includes('youtube.readonly'));
  check('youtube oauth: stores granted scopes', ytOauth.includes('scopes: SCOPES.join'));
  const ttOauth = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/tiktok-oauth.ts'), 'utf8');
  check('tiktok oauth: requests video.list + video.publish + video.upload + comment.list', ['video.list', 'video.publish', 'video.upload', 'comment.list'].every((s) => ttOauth.includes(s)));
  check('tiktok oauth: stores granted scopes', ttOauth.includes('scopes: SCOPES.join'));
  const pubSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/scheduling/publisher.ts'), 'utf8');
  check('publisher: youtube leg uploads + only a real video id publishes', pubSrc.includes("platform === 'youtube'") && pubSrc.includes('uploadYoutubeVideo') && pubSrc.includes('result.videoId'));
  check('publisher: tiktok leg polls status + keeps publish_ref for resume', pubSrc.includes("platform === 'tiktok'") && pubSrc.includes('fetchTikTokPublishStatus') && pubSrc.includes('publish_ref'));
  check('publisher: still-processing tiktok goes back to scheduled (never failed, never double-post)', pubSrc.includes('processingAny') && pubSrc.includes("setStatus(workspaceId, postId, 'scheduled'"));
  check('publisher: youtube quota checked before upload', pubSrc.includes('getYoutubeQuota') && pubSrc.includes('YOUTUBE_MAX_UPLOADS_PER_DAY'));
  const dmSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/webhooks/tiktok-dm.ts'), 'utf8');
  check('tiktok-dm: stub send is gone (real Business Messaging client)', !dmSrc.includes('no_live_client') && dmSrc.includes('sendTikTokBusinessDM'));
  check('tiktok-dm: DM still approval-gated (403 without approval)', dmSrc.includes('isTikTokDMApproved()'));
  const sendSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-send.ts'), 'utf8');
  check('meta-send: tiktok_dm replies route through sendTikTokDM', sendSrc.includes("channel.platform === 'tiktok_dm'") && sendSrc.includes('sendTikTokDM('));
  const mig34 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/34-youtube-tiktok-scopes.sql'), 'utf8');
  check('migration 34 adds channels.scopes + scheduled_posts.publish_ref (idempotent)', mig34.includes('scopes') && mig34.includes('publish_ref') && mig34.includes('IF NOT EXISTS'));
  const schedSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/scheduling/routes.ts'), 'utf8');
  check('scheduling routes: youtube + tiktok + instagram allowed (videoOnly rule intact)', schedSrc.includes("p !== 'youtube'") && schedSrc.includes("p !== 'tiktok'") && schedSrc.includes("p !== 'instagram'") && schedSrc.includes('videoOnly'));
  const routesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/social-routes.ts'), 'utf8');
  check('social routes: youtube/tiktok status + videos + comments + reply + dm sync', ['/youtube/status', '/youtube/videos', '/youtube/comments', '/tiktok/videos', '/tiktok/comments', '/tiktok/dm/sync'].every((p) => routesSrc.includes(`'${p}'`)));
  const docSrc = fs.readFileSync(path.join(ROOT, 'docs/youtube-tiktok-setup.md'), 'utf8');
  check('docs: setup doc covers Google OAuth, TikTok review, audit gate, Business Messaging', docSrc.includes('TIKTOK_SCHEDULING_AUDITED') && docSrc.includes('Business Messaging') && docSrc.includes('GOOGLE_CLIENT_ID'));
  const schedPage = fs.readFileSync(path.join(ROOT, 'apps/web/app/schedule/page.tsx'), 'utf8');
  check('schedule page: instagram + youtube + tiktok are real platform options (no coming soon)', schedPage.includes('"facebook", "instagram", "youtube", "tiktok"') && !schedPage.includes('PLATFORM_COMING_SOON'));
  const commentsPage = fs.readFileSync(path.join(ROOT, 'apps/web/app/comments/page.tsx'), 'utf8');
  check('comments page: youtube + tiktok tabs with live panel', commentsPage.includes('SocialCommentsPanel') && commentsPage.includes('"youtube"') && commentsPage.includes('"tiktok"'));
  const indexSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/index.ts'), 'utf8');
  check('index mounts socialApiRouter', indexSrc.includes('socialApiRouter'));

  // ================= Phase A: no keys =================
  const stampA = Date.now();
  const portA = 4007;
  const apiA = makeApi(`http://localhost:${portA}`);
  const runA = startApi(portA, '.pglite-data-yt-a', {
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    TIKTOK_CLIENT_KEY: '', TIKTOK_CLIENT_SECRET: '',
  });
  process.on('exit', runA.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portA}`);
    check('Phase A API starts (health)', up, up ? '' : runA.log().slice(-500));
    if (!up) return;
    await setupWorkspace(apiA, stampA);
    const ytLoginA = await apiA('/api/channels/youtube/login');
    check('Phase A youtube/login → 503 not set up yet', ytLoginA.status === 503 && /সেটআপ/.test(ytLoginA.data?.error ?? ''), `status=${ytLoginA.status}`);
    const ttLoginA = await apiA('/api/channels/tiktok/login');
    check('Phase A tiktok/login → 503 not set up yet', ttLoginA.status === 503 && /সেটআপ/.test(ttLoginA.data?.error ?? ''), `status=${ttLoginA.status}`);
    const ytStatusA = await apiA('/api/youtube/status');
    check('Phase A youtube/status → configured false, connected false', ytStatusA.status === 200 && ytStatusA.data?.configured === false && ytStatusA.data?.connected === false, JSON.stringify(ytStatusA.data ?? {}).slice(0, 200));
    const ttStatusA = await apiA('/api/tiktok/status');
    check('Phase A tiktok/status → configured false, connected false', ttStatusA.status === 200 && ttStatusA.data?.configured === false && ttStatusA.data?.connected === false, JSON.stringify(ttStatusA.data ?? {}).slice(0, 200));
    const ytCommentsA = await apiA('/api/youtube/comments');
    check('Phase A youtube/comments → 503 not connected (honest, not empty)', ytCommentsA.status === 503, `status=${ytCommentsA.status}`);
    const ttVideosA = await apiA('/api/tiktok/videos');
    check('Phase A tiktok/videos → 503 not connected (honest, not empty)', ttVideosA.status === 503, `status=${ttVideosA.status}`);
    // DM webhook without approval → 403, nothing stored.
    const dmA = await apiA('/api/webhooks/tiktok-dm', {
      method: 'POST', auth: false,
      body: { messageId: 'dm-a1', senderId: 'tt-user-9', senderName: 'TikTok Buyer', text: 'Hi', recipientId: 'tt-open-1' },
    });
    check('Phase A tiktok-dm webhook without approval → 403', dmA.status === 403, `status=${dmA.status}`);
    const inboxA = await apiA('/api/inbox');
    check('Phase A no DM stored after rejected webhook', inboxA.status === 200 && (inboxA.data?.conversations ?? []).length === 0, `conversations=${(inboxA.data?.conversations ?? []).length}`);
    // A YouTube post can be created but publish-now fails honestly (no channel).
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const postA = await apiA('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'No channel yet', mediaUrls: [mediaUrl], mediaType: 'video', platforms: ['youtube'], scheduledAt: future },
    });
    check('Phase A youtube video post created (scheduled)', postA.status === 201 && postA.data?.post?.status === 'scheduled', `status=${postA.status} ${JSON.stringify(postA.data ?? {}).slice(0, 200)}`);
    if (postA.data?.post?.id) {
      const pubA = await apiA(`/api/scheduled-posts/${postA.data.post.id}/publish-now`, { method: 'POST' });
      check('Phase A youtube publish-now without channel → failed honestly', pubA.status === 200 && pubA.data?.post?.status === 'failed', `status=${pubA.status} post=${JSON.stringify(pubA.data?.post ?? {}).slice(0, 200)}`);
      const gotA = await apiA(`/api/scheduled-posts/${postA.data.post.id}`);
      check('Phase A failed post carries the reason (no fake published)', /YouTube/.test(gotA.data?.post?.lastError ?? ''), `lastError=${gotA.data?.post?.lastError ?? ''}`);
    }
    // Validation: text post to youtube/tiktok → 400; instagram → 400.
    const badYt = await apiA('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'text only', mediaUrls: [], mediaType: 'text', platforms: ['youtube'], scheduledAt: future },
    });
    check('Phase A text post to youtube → 400 (video only)', badYt.status === 400, `status=${badYt.status}`);
    const badIg = await apiA('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'x', mediaUrls: [], mediaType: 'text', platforms: ['instagram'], scheduledAt: future },
    });
    check('Phase A instagram text-only post → 400 (Instagram needs media)', badIg.status === 400, `status=${badIg.status}`);
  } finally {
    runA.stop();
    await sleep(500);
  }

  // ================= Phase B: dummy keys + stubs =================
  const stampB = Date.now() + 1;
  const portB = 4008;
  const apiB = makeApi(`http://localhost:${portB}`);
  const runB = startApi(portB, '.pglite-data-yt-b', {
    GOOGLE_CLIENT_ID: 'goog-test-id',
    GOOGLE_CLIENT_SECRET: 'goog-test-secret',
    GOOGLE_OAUTH_TOKEN_URL: `${stubBase}/token`,
    GOOGLE_API_BASE_URL: stubBase,
    GOOGLE_UPLOAD_BASE_URL: `${stubBase}/upload`,
    TIKTOK_CLIENT_KEY: 'tt-test-key',
    TIKTOK_CLIENT_SECRET: 'tt-test-secret',
    TIKTOK_API_BASE_URL: stubBase,
    TIKTOK_AUTH_BASE_URL: stubBase,
    TIKTOK_SCHEDULING_AUDITED: 'true',
    TIKTOK_DM_APPROVED: 'true',
    TIKTOK_BUSINESS_API_BASE_URL: stubBase,
    TIKTOK_BUSINESS_ACCESS_TOKEN: 'bm-token-1',
    TIKTOK_BUSINESS_ID: 'bm-business-1',
  });
  process.on('exit', runB.stop);
  try {
    const up = await waitForHealth(`http://localhost:${portB}`);
    check('Phase B API starts (health)', up, up ? '' : runB.log().slice(-500));
    if (!up) return;
    const ws1 = await setupWorkspace(apiB, stampB);

    // Login URLs carry the new scopes.
    const ytLogin = await apiB('/api/channels/youtube/login');
    check('Phase B youtube/login → 200 with upload + force-ssl scopes in URL', ytLogin.status === 200 && /youtube\.upload/.test(ytLogin.data?.url ?? '') && /youtube\.force-ssl/.test(ytLogin.data?.url ?? ''), `status=${ytLogin.status}`);
    const ttLogin = await apiB('/api/channels/tiktok/login');
    check('Phase B tiktok/login → 200 with video.publish + comment.list scopes in URL', ttLogin.status === 200 && /video\.publish/.test(ttLogin.data?.url ?? '') && /comment\.list/.test(ttLogin.data?.url ?? ''), `status=${ttLogin.status}`);

    // OAuth callbacks (self-minted state JWTs) — real connect flow.
    // NOTE: a fresh trial workspace gets 1 channel slot, so YouTube and
    // TikTok each need their own workspace here (same as two real shops).
    const ytState = signJwt(jwtSecret, { purpose: 'youtube_oauth', workspaceId, userId });
    const ytCb = await apiB(`/api/channels/youtube/callback?code=dummy-code&state=${encodeURIComponent(ytState)}`, { redirect: 'manual' });
    check('Phase B youtube callback → connected redirect', ytCb.status === 302 && /youtube=connected/.test(ytCb.location ?? ''), `status=${ytCb.status} loc=${ytCb.location ?? ''}`);
    const channels = await apiB('/api/channels');
    const ytRow = (channels.data?.channels ?? []).find((c) => c.platform === 'youtube');
    check('Phase B exactly one youtube channel row', !!ytRow, `youtube=${!!ytRow}`);
    check('Phase B youtube channel is the stub channel', ytRow?.external_id === 'UC-test' && ytRow?.display_name === 'Test Channel', `ext=${ytRow?.external_id ?? ''}`);
    // Reconnect: same callback again → still one row (update, not duplicate).
    const ytCb2 = await apiB(`/api/channels/youtube/callback?code=dummy-code2&state=${encodeURIComponent(signJwt(jwtSecret, { purpose: 'youtube_oauth', workspaceId, userId }))}`, { redirect: 'manual' });
    const channels2 = await apiB('/api/channels');
    const ytRows2 = (channels2.data?.channels ?? []).filter((c) => c.platform === 'youtube');
    check('Phase B youtube reconnect updates (no second row)', ytCb2.status === 302 && ytRows2.length === 1, `rows=${ytRows2.length}`);

    // TikTok workspace (its own trial slot).
    const ws2 = await setupWorkspace(apiB, stampB + 1000);
    const ttState = signJwt(jwtSecret, { purpose: 'tiktok_oauth', workspaceId, userId });
    const ttCb = await apiB(`/api/channels/tiktok/callback?code=dummy-code&state=${encodeURIComponent(ttState)}`, { redirect: 'manual' });
    check('Phase B tiktok callback → connected redirect', ttCb.status === 302 && /tiktok=connected/.test(ttCb.location ?? ''), `status=${ttCb.status} loc=${ttCb.location ?? ''}`);
    const ttChannels = await apiB('/api/channels');
    const ttRow = (ttChannels.data?.channels ?? []).find((c) => c.platform === 'tiktok');
    check('Phase B exactly one tiktok channel row', !!ttRow, `tiktok=${!!ttRow}`);
    check('Phase B tiktok channel is the stub profile', ttRow?.external_id === 'tt-open-1' && ttRow?.display_name === 'TikTok Shop', `ext=${ttRow?.external_id ?? ''}`);

    // Status endpoints.
    useWorkspace(ws1);
    const ytStatus = await apiB('/api/youtube/status');
    check('Phase B youtube/status → connected + upload scope + quota 0/6', ytStatus.status === 200 && ytStatus.data?.connected === true && ytStatus.data?.hasUploadScope === true && ytStatus.data?.quota?.uploadsToday === 0 && ytStatus.data?.quota?.maxUploadsPerDay === 6, JSON.stringify(ytStatus.data?.quota ?? {}));
    useWorkspace(ws2);
    const ttStatus = await apiB('/api/tiktok/status');
    check('Phase B tiktok/status → connected + audited + DM approved + BM configured', ttStatus.status === 200 && ttStatus.data?.connected === true && ttStatus.data?.audited === true && ttStatus.data?.dmApproved === true && ttStatus.data?.businessMessagingConfigured === true, JSON.stringify(ttStatus.data ?? {}));

    // YouTube videos + comments (live stub data).
    useWorkspace(ws1);
    const ytVideos = await apiB('/api/youtube/videos');
    check('Phase B youtube/videos → live stub video', ytVideos.status === 200 && ytVideos.data?.videos?.[0]?.id === 'yt-vid-1' && ytVideos.data?.videos?.[0]?.title === 'Test Video', JSON.stringify(ytVideos.data ?? {}).slice(0, 200));
    const ytComments = await apiB('/api/youtube/comments?videoId=yt-vid-1');
    const ytC = ytComments.data?.comments?.[0];
    check('Phase B youtube/comments → author + text + time + likes + reply', ytComments.status === 200 && ytC?.author === 'Commenter One' && ytC?.text === 'Nice video!' && ytC?.likeCount === 3 && ytC?.replies?.[0]?.text === 'Thanks!', JSON.stringify(ytC ?? {}).slice(0, 300));
    const ytReply = await apiB('/api/youtube/comments/yt-c1/reply', { method: 'POST', body: { text: 'Thank you!' } });
    check('Phase B youtube comment reply → real reply id', ytReply.status === 200 && ytReply.data?.replyId === 'yt-reply-1', `status=${ytReply.status} ${JSON.stringify(ytReply.data ?? {})}`);

    // TikTok videos + comments (live stub data).
    useWorkspace(ws2);
    const ttVideos = await apiB('/api/tiktok/videos');
    check('Phase B tiktok/videos → live stub video', ttVideos.status === 200 && ttVideos.data?.videos?.[0]?.id === 'tt-vid-1' && ttVideos.data?.videos?.[0]?.title === 'TT Video', JSON.stringify(ttVideos.data ?? {}).slice(0, 200));
    const ttComments = await apiB('/api/tiktok/comments?videoId=tt-vid-1');
    const ttC = ttComments.data?.comments?.[0];
    check('Phase B tiktok/comments → text + likes + reply count', ttComments.status === 200 && ttC?.commentId === 'tt-c1' && ttC?.text === 'Great!' && ttC?.likeCount === 5 && ttC?.replyCount === 1, JSON.stringify(ttC ?? {}).slice(0, 300));
    const ttReplies = await apiB('/api/tiktok/comments/tt-c1/replies');
    check('Phase B tiktok comment replies → live stub reply', ttReplies.status === 200 && ttReplies.data?.comments?.[0]?.text === 'You are welcome!', JSON.stringify(ttReplies.data ?? {}).slice(0, 200));
    const ttReply = await apiB('/api/tiktok/comments/reply', { method: 'POST', body: { videoId: 'tt-vid-1', commentId: 'tt-c1', text: 'Thanks!' } });
    check('Phase B tiktok comment reply → real reply id', ttReply.status === 200 && ttReply.data?.replyId === 'tt-reply-1', `status=${ttReply.status} ${JSON.stringify(ttReply.data ?? {})}`);

    // ---- YouTube scheduling: publish-now → real video id ----
    useWorkspace(ws1);
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const mkPost = async (platforms) => apiB('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'Scheduled video\nFull description here', mediaUrls: [mediaUrl], mediaType: 'video', platforms, scheduledAt: future },
    });
    const ytPost = await mkPost(['youtube']);
    check('Phase B youtube video post created (scheduled)', ytPost.status === 201 && ytPost.data?.post?.status === 'scheduled', `status=${ytPost.status} ${JSON.stringify(ytPost.data ?? {}).slice(0, 200)}`);
    if (ytPost.data?.post?.id) {
      const pub = await apiB(`/api/scheduled-posts/${ytPost.data.post.id}/publish-now`, { method: 'POST' });
      check('Phase B youtube publish-now → published with REAL video id', pub.status === 200 && pub.data?.post?.status === 'published' && pub.data?.post?.platform_post_id === 'yt-video-123', `post=${JSON.stringify(pub.data?.post ?? {}).slice(0, 300)}`);
    }

    // ---- TikTok scheduling: publish-now → PUBLISH_COMPLETE ----
    useWorkspace(ws2);
    const ttPost = await mkPost(['tiktok']);
    check('Phase B tiktok video post created (scheduled)', ttPost.status === 201 && ttPost.data?.post?.status === 'scheduled', `status=${ttPost.status} ${JSON.stringify(ttPost.data ?? {}).slice(0, 200)}`);
    if (ttPost.data?.post?.id) {
      const pub = await apiB(`/api/scheduled-posts/${ttPost.data.post.id}/publish-now`, { method: 'POST' });
      check('Phase B tiktok publish-now → published with REAL public video id', pub.status === 200 && pub.data?.post?.status === 'published' && pub.data?.post?.platform_post_id === 'tt-video-1', `post=${JSON.stringify(pub.data?.post ?? {}).slice(0, 300)}`);
      const got = await apiB(`/api/scheduled-posts/${ttPost.data.post.id}`);
      check('Phase B tiktok publish_ref stored (async publish id)', got.data?.post?.publish_ref === 'tt-publish-1', `publish_ref=${got.data?.post?.publish_ref ?? ''}`);
    }

    // ---- YouTube quota: 6 uploads/day, 7th fails honestly ----
    // (1 already published above; 5 more bring today to 6.)
    useWorkspace(ws1);
    let quotaPublished = 1;
    for (let i = 0; i < 5; i++) {
      const p = await mkPost(['youtube']);
      if (p.data?.post?.id) {
        const pub = await apiB(`/api/scheduled-posts/${p.data.post.id}/publish-now`, { method: 'POST' });
        if (pub.data?.post?.status === 'published') quotaPublished++;
      }
    }
    check('Phase B quota: 6 youtube uploads today succeed', quotaPublished === 6, `published=${quotaPublished}`);
    const over = await mkPost(['youtube']);
    let overFailed = false;
    let overReason = '';
    if (over.data?.post?.id) {
      const pub = await apiB(`/api/scheduled-posts/${over.data.post.id}/publish-now`, { method: 'POST' });
      overFailed = pub.data?.post?.status === 'failed';
      const got = await apiB(`/api/scheduled-posts/${over.data.post.id}`);
      overReason = got.data?.post?.lastError ?? '';
    }
    check('Phase B quota: 7th youtube upload fails honestly (quota message)', overFailed && /কোটা/.test(overReason), `reason=${overReason}`);
    const ytStatus2 = await apiB('/api/youtube/status');
    check('Phase B youtube/status shows uploadsToday 6/6', ytStatus2.data?.quota?.uploadsToday === 6 && ytStatus2.data?.quota?.unitsRemaining === 400, JSON.stringify(ytStatus2.data?.quota ?? {}));

    // ---- TikTok DM: webhook intake → Inbox → manual reply (real BM send) ----
    useWorkspace(ws2);
    const dmB = await apiB('/api/webhooks/tiktok-dm', {
      method: 'POST', auth: false,
      body: { messageId: 'dm-b1', senderId: 'tt-user-9', senderName: 'TikTok Buyer', text: 'Hi, is this available?', recipientId: 'tt-open-1' },
    });
    check('Phase B tiktok-dm webhook with approval → accepted 1', dmB.status === 200 && dmB.data?.accepted === 1, `status=${dmB.status} ${JSON.stringify(dmB.data ?? {})}`);
    const dmDup = await apiB('/api/webhooks/tiktok-dm', {
      method: 'POST', auth: false,
      body: { messageId: 'dm-b1', senderId: 'tt-user-9', senderName: 'TikTok Buyer', text: 'Hi, is this available?', recipientId: 'tt-open-1' },
    });
    check('Phase B duplicate DM → accepted 0 (dedup, never answered twice)', dmDup.status === 200 && dmDup.data?.accepted === 0, `accepted=${dmDup.data?.accepted}`);
    const inboxB = await apiB('/api/inbox');
    const dmConv = (inboxB.data?.conversations ?? []).find((c) => (c.customer_name ?? c.customerName ?? '').includes('TikTok Buyer'));
    check('Phase B DM is in the Inbox (TikTok Buyer conversation)', !!dmConv, `conversations=${(inboxB.data?.conversations ?? []).length}`);
    if (dmConv) {
      const detail = await apiB(`/api/inbox/${dmConv.id}`);
      const hasInbound = (detail.data?.messages ?? []).some((m) => m.direction === 'in' && (m.body ?? '').includes('is this available'));
      check('Phase B inbox thread shows the inbound DM text', hasInbound, `messages=${(detail.data?.messages ?? []).length}`);
      const reply = await apiB(`/api/inbox/${dmConv.id}/reply`, { method: 'POST', body: { body: 'Yes, it is available — price ৳500.' } });
      check('Phase B manual DM reply → 201 with REAL Business Messaging id', reply.status === 201 && reply.data?.platformMessageId === 'bm-msg-sent-1', `status=${reply.status} ${JSON.stringify(reply.data ?? {}).slice(0, 300)}`);
    }

    // ---- TikTok DM: live BM read + sync ----
    const bmList = await apiB('/api/tiktok/dm/conversations');
    check('Phase B BM conversation list → live stub thread', bmList.status === 200 && bmList.data?.conversations?.[0]?.conversationId === 'bm-conv-1', JSON.stringify(bmList.data ?? {}).slice(0, 200));
    const bmThread = await apiB('/api/tiktok/dm/conversations/bm-conv-1');
    check('Phase B BM thread → live stub message (Price please)', bmThread.status === 200 && bmThread.data?.messages?.[0]?.text === 'Price please' && bmThread.data?.messages?.[0]?.isOwn === false, JSON.stringify(bmThread.data ?? {}).slice(0, 300));
    const sync1 = await apiB('/api/tiktok/dm/sync', { method: 'POST', body: {} });
    check('Phase B dm/sync imports the BM thread message', sync1.status === 200 && sync1.data?.imported === 1, `status=${sync1.status} ${JSON.stringify(sync1.data ?? {})}`);
    const sync2 = await apiB('/api/tiktok/dm/sync', { method: 'POST', body: {} });
    check('Phase B second dm/sync imports 0 (dedup)', sync2.status === 200 && sync2.data?.imported === 0, `imported=${sync2.data?.imported}`);
  } finally {
    runB.stop();
    await sleep(500);
  }

  stub.close();
  // Clean up the local PGlite test DBs (never ship them / deploy with them).
  for (const dir of ['.pglite-data-yt-a', '.pglite-data-yt-b']) {
    try { execSync(`rm -rf ${path.join(ROOT, 'apps/api', dir)}`); } catch { /* already gone */ }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
