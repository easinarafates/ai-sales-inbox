#!/usr/bin/env node
/**
 * Verification for overnight area 6 — comment intake + real comment
 * replies + Page post analysis.
 * Local, offline — no calls to graph.facebook.com, no Meta app needed.
 * A stub Graph server answers /{page-id}/posts, /{post-id}/comments and
 * POST /{comment-id}/comments so real data in → correct summary out
 * can be tested end to end.
 *
 * Static: companion facebook_comment row on OAuth connect, countChannels
 * excludes it, migration 17 backfills it, real comment reply via
 * POST /{comment-id}/comments (pages_manage_engagement scope),
 * comments /reply + /answer deliver via the shared helper (502 on
 * failure, never a false "answered"), page-posts analysis endpoint +
 * web page + nav.
 * Live: (A) analysis sorts by engagement, totals + top comments +
 * suggestions come from the stub data; empty Page → honest empty
 * state; Graph denial → 502 with the Graph code. (B) webhook feed
 * comment is saved to /api/comments (needs the facebook_comment
 * channel row) and a manual reply is REALLY posted to the stub Graph
 * (comment marked answered only after Graph accepts it); a Graph
 * denial → 502 and the comment stays to_check. (C) hand-logged comment
 * answer stays local-only and says so (delivered: false). (D) restart
 * backfill: a messenger channel created before the migration gets its
 * facebook_comment companion row on the next boot, and the subscription
 * limit still counts it as 1 channel.
 *
 * Run from the repo root:  node scripts/verify-post-analysis.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';

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

function makeApi(base) {
  return async function api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    // Generous client timeout: under a loaded machine (parallel suite
    // runs) the API can take a while to answer; undici's default
    // headers timeout is far shorter and would fail a healthy-but-slow
    // call. The server side still enforces its own 15s Graph timeout.
    const res = await fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(180000),
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
    return { status: res.status, data, text };
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
      DATABASE_URL: `pglite://./${dataDir}`,
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
  const email = `pa+${stamp}@example.com`;
  const signup = await api('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { name: 'PA Owner', email, password: 'verify1234', workspaceName: 'PA Shop' },
  });
  check(`signup (${stamp})`, signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
  token = signup.data?.token ?? '';
  return signup.data?.workspace?.id ?? '';
}

async function main() {
  const stamp = Date.now().toString(36);

  // ---------- Static checks ----------
  const sendSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-send.ts'), 'utf8');
  check('meta-send has sendFacebookCommentReply (POST /{comment-id}/comments, Page token Bearer)', sendSrc.includes('export async function sendFacebookCommentReply') && sendSrc.includes('/comments') && sendSrc.includes('message: input.text'));
  check('meta-send comment reply returns the reply comment id (Graph {id})', sendSrc.includes("typeof data?.id === 'string'"));
  check('deliverOutgoingMessage handles facebook_comment via the latest inbound comment id', sendSrc.includes("channel.platform === 'facebook_comment'") && sendSrc.includes('no_comment_to_reply_to'));
  check('deliverOutgoingMessage no longer lists facebook_comment as unsupported', !sendSrc.includes('send_not_supported_for_') || !sendSrc.includes('facebook_comment are NOT sent'));
  check('meta-send exports the Graph base for the analysis module', sendSrc.includes('export function graphBaseUrl'));

  const commentsSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/comments/routes.ts'), 'utf8');
  check('comments /reply + /answer deliver via the shared helper', commentsSrc.includes('deliverOutgoingMessage') && (commentsSrc.match(/deliverOutgoingMessage\(workspaceId/g) ?? []).length >= 2);
  check('comments reply returns 502 (not a false answered) when delivery fails', commentsSrc.includes('status(502)') && commentsSrc.includes('Reply could not be delivered'));
  check('comments reply marks answered only after delivery succeeds', commentsSrc.indexOf('Deliver for real first') !== -1 || commentsSrc.indexOf('only mark answered when Graph accepted it') !== -1);
  check('comments answer says honestly when there is no Facebook comment to reply to', commentsSrc.includes('delivered: false') && commentsSrc.includes('deliveryNote'));

  const metaSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/meta-oauth.ts'), 'utf8');
  check('OAuth connect creates a companion facebook_comment row (same Page + token)', metaSrc.includes("platform = 'facebook_comment'") && metaSrc.includes("INSERT INTO channels (workspace_id, platform, external_id, display_name, token_encrypted, status, token_expires_at, picture_url, source_id, user_token_encrypted, connected_by_user_id)"));
  check('companion row is idempotent (checked before insert, never fails the connect)', metaSrc.includes('companion facebook_comment channel failed') && metaSrc.includes('existing.rows.length === 0'));

  const subSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/subscriptions/service.ts'), 'utf8');
  check('countChannels excludes facebook_comment (same Page, not a second channel)', subSrc.includes("platform <> 'facebook_comment'"));

  const mig17 = fs.readFileSync(path.join(ROOT, 'apps/api/src/db/migrations/17-facebook-comment-companion.sql'), 'utf8');
  check('migration 17 backfills companion rows for existing messenger channels (idempotent)', mig17.includes("platform = 'messenger'") && mig17.includes('NOT EXISTS') && mig17.includes("'facebook_comment'"));

  const channelsRoutesSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/routes.ts'), 'utf8');
  check('manual channel connect does not charge a slot for facebook_comment', channelsRoutesSrc.includes("platform !== 'facebook_comment'"));

  const fbSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/channels/facebook-oauth.ts'), 'utf8');
  check('facebook login requests pages_manage_engagement (comment replies as the Page)', fbSrc.includes('pages_manage_engagement'));

  const analysisSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/analytics/page-posts-analysis.ts'), 'utf8');
  check('analysis fetches /{page-id}/posts with likes/comments/shares', analysisSrc.includes('/posts?') && analysisSrc.includes('likes.summary(true)') && analysisSrc.includes('comments.summary(true)') && analysisSrc.includes('shares'));
  check('analysis sorts by engagement and reports top comments (one line each)', analysisSrc.includes('engagement') && analysisSrc.includes('topComments') && analysisSrc.includes('/comments?'));
  check('analysis has an honest empty state (no Page / no posts)', analysisSrc.includes('এখনো কোনো Facebook Page যুক্ত হয়নি') && analysisSrc.includes('এই পেজে এখনো কোনো পোস্ট পাওয়া যায়নি'));
  check('analysis fails honestly on Graph denial (502 + Graph code, nothing faked)', analysisSrc.includes("status(502)") && analysisSrc.includes('facebook_graph_error'));
  check('analysis never puts the Page token in a URL (Bearer header only)', analysisSrc.includes('Authorization: `Bearer ${pageToken}`') && !analysisSrc.includes('access_token='));
  const indexSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/index.ts'), 'utf8');
  check('analysis router is mounted at /api', indexSrc.includes('pagePostsAnalysisRouter') && indexSrc.includes("app.use('/api', pagePostsAnalysisRouter)"));
  const webPageSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/post-analysis/page.tsx'), 'utf8');
  check('web has a Post analysis page (totals, suggestions, top comments, empty + error states)', webPageSrc.includes('analyticsApi.pagePosts') && webPageSrc.includes('suggestions') && webPageSrc.includes('topComments'));
  const sidebarSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/Sidebar.tsx'), 'utf8');
  check('sidebar links to /post-analysis', sidebarSrc.includes('/post-analysis'));
  const apiClientSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/api.ts'), 'utf8');
  check('web api client has analyticsApi.pagePosts', apiClientSrc.includes('pagePosts'));

  // ---------- Stub Graph ----------
  const stubHits = [];
  const graphStub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { /* ignore */ }
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      stubHits.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? '', body: parsed });
      const url = req.url ?? '';
      if (req.method === 'GET' && url.startsWith('/v21.0/page-pa-1/posts')) {
        return send(200, {
          data: [
            { id: 'p1', message: 'New winter collection is here', created_time: '2026-11-06T10:00:00+0000', permalink_url: 'https://facebook.com/p1', likes: { summary: { total_count: 10 } }, comments: { summary: { total_count: 5 } }, shares: { count: 2 } },
            { id: 'p2', message: 'Price list for all dresses', created_time: '2026-11-05T10:00:00+0000', permalink_url: 'https://facebook.com/p2', likes: { summary: { total_count: 50 } }, comments: { summary: { total_count: 1 } }, shares: { count: 0 } },
            { id: 'p3', message: 'Good morning everyone', created_time: '2026-11-04T10:00:00+0000', permalink_url: 'https://facebook.com/p3', likes: { summary: { total_count: 0 } }, comments: { summary: { total_count: 0 } }, shares: { count: 0 } },
          ],
        });
      }
      if (req.method === 'GET' && url.startsWith('/v21.0/p2/comments')) {
        return send(200, { data: [
          { from: { name: 'Rahim' }, message: 'দাম কত?', created_time: '2026-11-05T11:00:00+0000' },
          { from: { name: 'Karim' }, message: 'Delivery charge?', created_time: '2026-11-05T12:00:00+0000' },
        ] });
      }
      if (req.method === 'GET' && url.startsWith('/v21.0/p1/comments')) {
        return send(200, { data: [
          { from: { name: 'Sakib' }, message: 'Nice collection!', created_time: '2026-11-06T11:00:00+0000' },
        ] });
      }
      if (req.method === 'GET' && url.startsWith('/v21.0/page-pa-empty/posts')) {
        return send(200, { data: [] });
      }
      if (req.method === 'GET' && url.startsWith('/v21.0/page-pa-denied/posts')) {
        return send(403, { error: { message: '(#200) Requires pages_read_engagement permission to access this endpoint.', code: 200, type: 'OAuthException' } });
      }
      if (req.method === 'POST' && url === '/v21.0/cmt-1/comments') {
        return send(200, { id: 'reply-cmt-1' });
      }
      if (req.method === 'POST' && url === '/v21.0/cmt-denied/comments') {
        return send(403, { error: { message: '(#200) Requires pages_manage_engagement permission to manage comments.', code: 200, type: 'OAuthException' } });
      }
      return send(404, { error: { message: `stub: no route for ${req.method} ${url}`, code: 404 } });
    });
  });
  const stubPort = 4011;
  await new Promise((resolve) => graphStub.listen(stubPort, resolve));

  // ---------- Live API ----------
  const port = 4012;
  const dataDir = '.pglite-data-pa';
  const api = makeApi(`http://localhost:${port}`);
  const run = startApi(port, dataDir, { META_APP_ID: 'dummy-app-id', META_APP_SECRET: 'dummy-secret', META_GRAPH_BASE_URL: `http://localhost:${stubPort}/v21.0` });
  try {
    const up = await waitForHealth(`http://localhost:${port}`);
    check('API boots (PGlite)', up);
    if (!up) {
      console.log('API log tail:\n', run.log().slice(-3000));
      return finish(1);
    }

    // ---- A: analysis with real stub data ----
    await setupWorkspace(api, `${stamp}-a`);
    const chA = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-pa-1', displayName: 'PA Page', token: 'tok-pa-1' } });
    check('A messenger channel → 201', chA.status === 201, `status=${chA.status}`);
    const analysis = await api('/api/analytics/page-posts');
    check('A analysis → 200 with 3 posts', analysis.status === 200 && analysis.data?.posts?.length === 3, `status=${analysis.status}, posts=${analysis.data?.posts?.length}`);
    const posts = analysis.data?.posts ?? [];
    check('A posts sorted by engagement desc (p2 first, p3 last)', posts[0]?.id === 'p2' && posts[1]?.id === 'p1' && posts[2]?.id === 'p3', JSON.stringify(posts.map((p) => [p.id, p.engagement])));
    check('A totals are the real stub numbers (60 likes, 6 comments, 2 shares)', analysis.data?.totals?.likes === 60 && analysis.data?.totals?.comments === 6 && analysis.data?.totals?.shares === 2, JSON.stringify(analysis.data?.totals));
    check('A topPostId is the most-engaged post', analysis.data?.topPostId === 'p2');
    const topComments = analysis.data?.topComments ?? [];
    check('A top comments are the real stub comments (Rahim + Karim + Sakib)', topComments.length === 3 && topComments.some((c) => c.author === 'Rahim' && c.text === 'দাম কত?') && topComments.some((c) => c.author === 'Karim'), JSON.stringify(topComments));
    check('A suggestions are present and data-derived', Array.isArray(analysis.data?.suggestions) && analysis.data.suggestions.length > 0, JSON.stringify(analysis.data?.suggestions));
    const postsHit = stubHits.find((h) => h.path.startsWith('/v21.0/page-pa-1/posts'));
    check('A stub Graph got the posts fetch with the Page token as Bearer', !!postsHit && postsHit.auth === 'Bearer tok-pa-1', JSON.stringify(postsHit?.auth ?? null));

    // ---- A2: empty Page → honest empty state ----
    await setupWorkspace(api, `${stamp}-b`);
    const chB = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-pa-empty', displayName: 'Empty Page', token: 'tok-pa-empty' } });
    check('A2 empty-page channel → 201', chB.status === 201, `status=${chB.status}`);
    const empty = await api('/api/analytics/page-posts');
    check('A2 empty Page → 200, posts [] + honest message (nothing invented)', empty.status === 200 && Array.isArray(empty.data?.posts) && empty.data.posts.length === 0 && typeof empty.data?.message === 'string', `status=${empty.status}, message=${empty.data?.message}`);

    // ---- A3: Graph denial → 502 with the Graph code ----
    await setupWorkspace(api, `${stamp}-c`);
    const chC = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-pa-denied', displayName: 'Denied Page', token: 'tok-pa-denied' } });
    check('A3 denied-page channel → 201', chC.status === 201, `status=${chC.status}`);
    const denied = await api('/api/analytics/page-posts');
    check('A3 Graph denial → 502 facebook_graph_error with code 200', denied.status === 502 && denied.data?.error === 'facebook_graph_error' && denied.data?.code === 200, `status=${denied.status}, body=${JSON.stringify(denied.data)}`);

    // ---- B: comment intake + real reply ----
    await setupWorkspace(api, `${stamp}-d`);
    const chD1 = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-pa-cmt', displayName: 'Comment Page', token: 'tok-cmt' } });
    const chD2 = await api('/api/channels', { method: 'POST', body: { platform: 'facebook_comment', externalId: 'page-pa-cmt', displayName: 'Comment Page', token: 'tok-cmt' } });
    check('B messenger + facebook_comment channels → 201', chD1.status === 201 && chD2.status === 201, `status=${chD1.status}/${chD2.status}`);
    const webhook = await api('/api/webhooks/meta', {
      method: 'POST', auth: false,
      body: {
        object: 'page',
        entry: [{
          id: 'page-pa-cmt',
          changes: [{
            field: 'feed',
            value: { item: 'comment', message: 'দাম কত?', comment_id: 'cmt-1', post_id: 'page-pa-cmt_post-9', from: { id: 'user-1', name: 'Rahim' } },
          }],
        }],
      },
    });
    check('B webhook feed comment → 200', webhook.status === 200, `status=${webhook.status}`);
    const comments = await api('/api/comments');
    const saved = (comments.data?.comments ?? []).find((c) => c.platform_comment_id === 'cmt-1');
    check('B comment saved in the Inbox (body + post id, to_check)', !!saved && saved.body === 'দাম কত?' && saved.platform_post_id === 'page-pa-cmt_post-9' && saved.status === 'to_check', JSON.stringify(saved ?? comments.data));
    const reply = await api(`/api/comments/${saved.id}/reply`, { method: 'POST', body: { text: 'দাম ৳৫০০, ডেলিভারি ঢাকায় ৳৬০।' } });
    check('B comment reply → 200 delivered with the stub reply id', reply.status === 200 && reply.data?.delivered === true && reply.data?.platformMessageId === 'reply-cmt-1', `status=${reply.status}, body=${JSON.stringify(reply.data)}`);
    const replyHit = stubHits.find((h) => h.path === '/v21.0/cmt-1/comments' && h.body?.message === 'দাম ৳৫০০, ডেলিভারি ঢাকায় ৳৬০।');
    check('B stub Graph got POST /cmt-1/comments with the Page token + reply text', !!replyHit && replyHit.auth === 'Bearer tok-cmt', JSON.stringify(replyHit ?? null));
    const after = await api('/api/comments');
    const answered = (after.data?.comments ?? []).find((c) => c.platform_comment_id === 'cmt-1');
    check('B comment is answered only after Graph accepted it', answered?.status === 'answered' && answered?.replied === true, JSON.stringify(answered ?? null));

    // ---- B2: Graph denial on reply → 502, comment stays to_check ----
    const webhook2 = await api('/api/webhooks/meta', {
      method: 'POST', auth: false,
      body: {
        object: 'page',
        entry: [{
          id: 'page-pa-cmt',
          changes: [{
            field: 'feed',
            value: { item: 'comment', message: 'আরেকটা প্রশ্ন', comment_id: 'cmt-denied', post_id: 'page-pa-cmt_post-9', from: { id: 'user-2', name: 'Karim' } },
          }],
        }],
      },
    });
    check('B2 second webhook comment → 200', webhook2.status === 200, `status=${webhook2.status}`);
    const comments2 = await api('/api/comments');
    const denied1 = (comments2.data?.comments ?? []).find((c) => c.platform_comment_id === 'cmt-denied');
    check('B2 denied comment saved as to_check', !!denied1 && denied1.status === 'to_check', JSON.stringify(denied1 ?? null));
    const replyDenied = await api(`/api/comments/${denied1.id}/reply`, { method: 'POST', body: { text: 'উত্তর' } });
    check('B2 denied reply → 502 (not a false answered)', replyDenied.status === 502, `status=${replyDenied.status}, body=${JSON.stringify(replyDenied.data)}`);
    const afterDenied = await api('/api/comments');
    const stillOpen = (afterDenied.data?.comments ?? []).find((c) => c.platform_comment_id === 'cmt-denied');
    check('B2 denied comment stays to_check after the failed reply', stillOpen?.status === 'to_check' && stillOpen?.replied === false, JSON.stringify(stillOpen ?? null));

    // ---- C: hand-logged comment answer stays local-only, honestly ----
    const manual = await api('/api/comments', { method: 'POST', body: { body: 'manual note, no Facebook comment' } });
    check('C hand-logged comment → 201', manual.status === 201, `status=${manual.status}`);
    const answer = await api(`/api/comments/${manual.data?.comment?.id}/answer`, { method: 'POST', body: { text: 'noted' } });
    check('C answer without a linked comment → 200 delivered:false + note', answer.status === 200 && answer.data?.delivered === false && typeof answer.data?.deliveryNote === 'string', `status=${answer.status}, body=${JSON.stringify(answer.data)}`);
    check('C hand-logged comment is still marked answered locally', answer.data?.comment?.status === 'answered');

    // ---- D: restart backfill ----
    await setupWorkspace(api, `${stamp}-e`);
    const chE = await api('/api/channels', { method: 'POST', body: { platform: 'messenger', externalId: 'page-pa-bf', displayName: 'Backfill Page', token: 'tok-pa-bf' } });
    check('D messenger channel → 201', chE.status === 201, `status=${chE.status}`);
    const before = await api('/api/channels');
    const beforeRows = (before.data?.channels ?? before.data ?? []);
    check('D no facebook_comment row before the restart (manual connect does not create it)', !beforeRows.some((c) => c.platform === 'facebook_comment' && c.external_id === 'page-pa-bf'), JSON.stringify(beforeRows.map((c) => [c.platform, c.external_id])));
  } finally {
    run.stop();
    await sleep(1500);
  }

  // Restart on the SAME data dir: migration 17 must backfill the row.
  const run2 = startApi(port, dataDir, { META_APP_ID: 'dummy-app-id', META_APP_SECRET: 'dummy-secret', META_GRAPH_BASE_URL: `http://localhost:${stubPort}/v21.0` });
  try {
    const up2 = await waitForHealth(`http://localhost:${port}`);
    check('D API restarts on the same data dir', up2);
    if (up2) {
      await setupWorkspace(api, `${stamp}-f`);
      // The backfilled workspace is the -e one; list channels as a fresh
      // workspace cannot see them — so check via the -e login instead.
      // (setupWorkspace above switched the token; re-login as -e.)
      const loginE = await api('/api/auth/login', {
        method: 'POST', auth: false,
        body: { email: `pa+${stamp}-e@example.com`, password: 'verify1234' },
      });
      check('D re-login as the backfill workspace', loginE.status === 200 && !!loginE.data?.token, `status=${loginE.status}`);
      token = loginE.data?.token ?? '';
      const afterRestart = await api('/api/channels');
      const rows = (afterRestart.data?.channels ?? afterRestart.data ?? []);
      check('D companion facebook_comment row exists after restart (migration 17)', rows.some((c) => c.platform === 'facebook_comment' && c.external_id === 'page-pa-bf'), JSON.stringify(rows.map((c) => [c.platform, c.external_id])));
      const current = await api('/api/subscriptions/current');
      const used = current.data?.current?.limits?.channels?.used;
      check('D subscription still counts 1 channel (companion row is free)', used === 1, `used=${used}, body=${JSON.stringify(current.data?.current?.limits ?? null)}`);
      const second = await api('/api/channels', { method: 'POST', body: { platform: 'webchat', externalId: 'site-pa', displayName: 'Site' } });
      check('D second real channel is still blocked by the trial limit (402)', second.status === 402, `status=${second.status}`);
    }
  } finally {
    run2.stop();
    try { graphStub.close(); } catch { /* already closed */ }
  }

  return finish(0);
}

function finish(code) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — ${failed.length} FAILED` : ''}`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL: ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  process.exit(failed.length > 0 ? 1 : code);
}

main().catch((err) => {
  console.error('Verifier crashed:', err);
  process.exit(1);
});
