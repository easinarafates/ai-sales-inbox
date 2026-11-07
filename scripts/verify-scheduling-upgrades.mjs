#!/usr/bin/env node
/**
 * Verification for the Post Schedule upgrades (Worker C).
 * Run from the repo root:
 *   node scripts/verify-scheduling-upgrades.mjs
 *
 * Starts its OWN API (tsx, port 4011) on a throwaway PGlite data dir in
 * /tmp, so it never touches the real local database or port 4000.
 * Covers: 15/day limit (16th rejected 400), 7-day window (beyond 7 days
 * rejected 400), publish frees a slot (15 -> publish attempt -> add 1
 * succeeds), base64 image upload returns a servable URL, auto-caption returns 2-3
 * options containing the REAL product price (never invented), MEDIA-AWARE
 * auto-caption (Gemini vision analyzes the attached image/video and the
 * caption comes from what is actually in it — red/blue test PNG, small
 * red test video via the inline path, >18 MB test video via the Gemini
 * File API path, bogus media URL falls back honestly with no fake
 * analysis), video post create + list shows media_type 'video'.
 * REAL publishing (2026-11-07): publish-now with NO Page connected must
 * FAIL honestly (never a fake 'published', no stub- id); with a test Page
 * channel connected and Meta Graph pointed at a local fake server
 * (META_GRAPH_BASE_URL), text / image / video posts publish for real and
 * store Graph's ids, liking a Page post + a comment reaches Graph, a due
 * post publishes when the Schedule list loads (lazy sweep), and a failed
 * post carries its reason (lastError) in the list.
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 * NOTE: uses only test data in a fresh workspace; nothing is sent to Meta.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'apps', 'api');
const PORT = Number(process.env.VERIFY_PORT ?? 4011);
const API = `http://localhost:${PORT}`;
const results = [];
let token = '';

/**
 * Fake Meta Graph server (META_GRAPH_BASE_URL override): answers the
 * exact calls the real publisher + like endpoints make, with fixed ids
 * — so the verifier proves a publish reaches Graph and stores Graph's
 * id, never a stub id, without touching real Facebook. Every request
 * is recorded in graphCalls for assertions.
 */
const FAKE_GRAPH_PORT = Number(process.env.FAKE_GRAPH_PORT ?? 4021);
const graphCalls = [];
function startFakeGraph() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d.toString(); });
    req.on('end', () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
      graphCalls.push({ method: req.method, path: req.url, body: parsed });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/v21.0/12345/feed') return send(200, { id: '12345_67890' });
      if (req.method === 'POST' && req.url === '/v21.0/12345/photos') return send(200, { id: 'photo_1', post_id: '12345_67891' });
      if (req.method === 'POST' && req.url === '/v21.0/12345/videos') return send(200, { id: 'video_1' });
      if (req.method === 'POST' && req.url === '/v21.0/12345_67890/likes') return send(200, { success: true });
      if (req.method === 'POST' && req.url === '/v21.0/comment_1/likes') return send(200, { success: true });
      return send(404, { error: { message: 'fake Graph: unknown route ' + req.url, code: 404 } });
    });
  });
  return new Promise((resolve) => server.listen(FAKE_GRAPH_PORT, '127.0.0.1', () => resolve(server)));
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(pathname, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
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
}

function parseEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const dhakaDate = (d) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

async function waitForHealth(child, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`API exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${API}/api/health`);
      if (res.status === 200) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('timed out waiting for API health');
}

async function main() {
  const fakeGraph = await startFakeGraph();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-verify-'));
  const dataDir = path.join(tmpDir, 'pglite-data');
  const env = {
    ...process.env,
    ...parseEnvFile(path.join(API_DIR, '.env')),
    PORT: String(PORT),
    DATABASE_URL: `pglite://${dataDir}`,
    // Point Meta Graph at the fake server above (meta-send reads this
    // env var on every call) — nothing in this verifier touches real Meta.
    META_GRAPH_BASE_URL: `http://127.0.0.1:${FAKE_GRAPH_PORT}/v21.0`,
  };
  const tsxBin = path.join(API_DIR, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsxBin, ['src/index.ts'], {
    cwd: API_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let apiLog = '';
  child.stdout.on('data', (d) => { apiLog += d.toString(); });
  child.stderr.on('data', (d) => { apiLog += d.toString(); });

  try {
    await waitForHealth(child);
    check('API starts on throwaway PGlite DB (migration 09 applied)', true, `port=${PORT}`);

    const stamp = Date.now();
    const email = `sched-verify+${stamp}@example.com`;

    // Signup (fresh workspace)
    const signup = await api('/api/auth/signup', {
      method: 'POST',
      auth: false,
      body: { name: 'Sched Verify', email, password: 'verify1234', workspaceName: 'Sched Verify Shop' },
    });
    check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    if (!token) throw new Error('no token from signup — cannot continue');

    // One real product: ৳1500 (150000 paisa), stock 5.
    const p1 = await api('/api/products', {
      method: 'POST',
      body: { name: 'শাড়ি', pricePaisa: 150000, size: 'M', stock: 5, description: 'সুতির শাড়ি — লাল' },
    });
    const product = p1.data?.product ?? null;
    check('add product (শাড়ি, ৳1500)', p1.status === 201 && product?.price_paisa === 150000, `status=${p1.status}`);

    // Target day: tomorrow (Dhaka), inside the 7-day window.
    const target = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const targetDate = dhakaDate(target);
    const atTime = (hour, minute) => {
      const d = new Date(target);
      // Build the time in Dhaka (+06:00) so it lands on targetDate.
      return new Date(`${targetDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+06:00`).toISOString();
    };

    // 1. Fill the day: 15 scheduled posts must all succeed.
    const createdIds = [];
    let fillOk = true;
    for (let i = 0; i < 15; i++) {
      const r = await api('/api/scheduled-posts', {
        method: 'POST',
        body: {
          caption: `টেস্ট পোস্ট ${i + 1}`,
          mediaType: 'text',
          platforms: ['facebook'],
          scheduledAt: atTime(8 + Math.floor(i / 2), (i % 2) * 30),
        },
      });
      if (r.status !== 201) fillOk = false;
      else createdIds.push(r.data?.post?.id);
    }
    check('15 scheduled posts on one day all succeed', fillOk && createdIds.length === 15, `created=${createdIds.length}`);

    // List must report the per-day count (n/15).
    const list = await api('/api/scheduled-posts');
    check(
      'list returns per-day counts (n/15)',
      list.status === 200 && Number(list.data?.counts?.[targetDate]) === 15 && Number(list.data?.maxPerDay) === 15,
      `counts[${targetDate}]=${list.data?.counts?.[targetDate]}, maxPerDay=${list.data?.maxPerDay}`,
    );

    // 2. The 16th post on the same day must be rejected with 400.
    const sixteenth = await api('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'টেস্ট পোস্ট ১৬', mediaType: 'text', platforms: ['facebook'], scheduledAt: atTime(18, 0) },
    });
    check(
      '16th post on the same day rejected (400)',
      sixteenth.status === 400 && typeof sixteenth.data?.error === 'string' && sixteenth.data.error.length > 0,
      `status=${sixteenth.status}, error=${sixteenth.data?.error ?? ''}`,
    );

    // 3. scheduled_at beyond 7 days must be rejected with 400.
    const far = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();
    const farPost = await api('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'অনেক দূরের পোস্ট', mediaType: 'text', platforms: ['facebook'], scheduledAt: far },
    });
    check(
      'scheduled_at beyond 7 days rejected (400)',
      farPost.status === 400,
      `status=${farPost.status}, error=${farPost.data?.error ?? ''}`,
    );
    // And a date inside the window (day 6) must be accepted.
    const day6 = dhakaDate(new Date(Date.now() + 6 * 24 * 60 * 60 * 1000));
    const ok6 = await api('/api/scheduled-posts', {
      method: 'POST',
      body: {
        caption: '৬ দিন পরের পোস্ট',
        mediaType: 'text',
        platforms: ['facebook'],
        scheduledAt: new Date(`${day6}T10:00:00+06:00`).toISOString(),
      },
    });
    check('scheduled_at on day 6 (inside window) accepted', ok6.status === 201, `status=${ok6.status}`);

    // 4. Publishing frees the slot: publish 1 of the 15 — with no Page
    // connected it must FAIL honestly (never a fake 'published'), and a
    // failed post frees its slot just like a published one.
    const pub = await api(`/api/scheduled-posts/${createdIds[0]}/publish-now`, { method: 'POST' });
    check(
      'publish-now without a connected Page fails honestly (never fake published, no stub- id)',
      pub.status === 200 && pub.data?.post?.status === 'failed' && !String(pub.data?.post?.platform_post_id ?? '').startsWith('stub-'),
      `status=${pub.data?.post?.status}, platform_post_id=${pub.data?.post?.platform_post_id ?? ''}`,
    );
    const afterPub = await api('/api/scheduled-posts');
    check(
      'failed post no longer counts toward the day (14/15)',
      Number(afterPub.data?.counts?.[targetDate]) === 14,
      `counts[${targetDate}]=${afterPub.data?.counts?.[targetDate]}`,
    );
    const refill = await api('/api/scheduled-posts', {
      method: 'POST',
      body: { caption: 'খালি স্লটে নতুন পোস্ট', mediaType: 'text', platforms: ['facebook'], scheduledAt: atTime(19, 0) },
    });
    check('after publish, adding 1 more post succeeds (slot freed)', refill.status === 201, `status=${refill.status}`);

    // 5. Upload: small base64 PNG image -> servable URL.
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = await api('/api/scheduled-posts/upload', {
      method: 'POST',
      body: { fileBase64: `data:image/png;base64,${pngBase64}`, fileName: 'test.png', mimeType: 'image/png' },
    });
    check(
      'upload accepts small base64 image and returns a URL',
      up.status === 201 && typeof up.data?.url === 'string' && up.data.url.startsWith('/api/uploads/') && up.data?.mediaType === 'image',
      `status=${up.status}, url=${up.data?.url ?? ''}`,
    );
    if (up.data?.url) {
      // NOTE: /api/uploads sits behind the API's auth for now (other
      // routers mounted at /api run requireAuth first — see routes.ts).
      // The web UI fetches previews with the token; truly public
      // serving needs a one-line index.ts change by the coordinator.
      const fetched = await fetch(`${API}${up.data.url}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const buf = Buffer.from(await fetched.arrayBuffer());
      check(
        'uploaded image URL is servable with auth (GET 200, PNG bytes)',
        fetched.status === 200 && buf.length > 0 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
        `GET status=${fetched.status}, bytes=${buf.length}`,
      );
      const anon = await fetch(`${API}${up.data.url}`);
      check(
        'uploaded image URL without auth is 401 (expected until index.ts serves /uploads publicly)',
        anon.status === 401,
        `GET status=${anon.status}`,
      );
    } else {
      check('uploaded image URL is servable with auth (GET 200, PNG bytes)', false, 'no URL returned');
      check('uploaded image URL without auth is 401 (expected until index.ts serves /uploads publicly)', false, 'no URL returned');
    }
    // Bad mime type must be rejected.
    const badUp = await api('/api/scheduled-posts/upload', {
      method: 'POST',
      body: { fileBase64: Buffer.from('hello').toString('base64'), fileName: 'x.txt', mimeType: 'text/plain' },
    });
    check('upload rejects non-image/video mime (400)', badUp.status === 400, `status=${badUp.status}`);

    // 6. Auto caption: 2-3 options containing the REAL price ৳1500.
    const cap = await api('/api/scheduled-posts/auto-caption', {
      method: 'POST',
      body: { productIds: [product.id], lang: 'bn' },
    });
    const options = Array.isArray(cap.data?.options) ? cap.data.options : [];
    const hasRealPrice = options.some((o) => typeof o === 'string' && o.includes('1500'));
    const hasInventedPrice = options.some((o) => typeof o === 'string' && /9999|8888|7777|10000/.test(o));
    check(
      'auto-caption returns 2–3 options',
      cap.status === 200 && options.length >= 2 && options.length <= 3,
      `status=${cap.status}, options=${options.length}, aiGenerated=${cap.data?.aiGenerated}`,
    );
    check(
      'auto-caption options contain the real product price (৳1500)',
      hasRealPrice,
      options.map((o) => String(o).slice(0, 80)).join(' | '),
    );
    check('auto-caption invents no price', !hasInventedPrice, '');

    // 6b. Media-aware auto-caption: Gemini vision must describe what is
    // actually in the image/video, and the caption must come from that.
    // A red/blue test PNG (top half red, bottom half blue) is generated
    // in-process — no fixture files, no network.
    const crcTable = (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
      }
      return t;
    })();
    const crc32 = (buf) => {
      let c = 0xffffffff;
      for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const pngChunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const makeRedBluePng = () => {
      const w = 64, h = 64;
      const raw = Buffer.alloc(h * (1 + w * 3));
      for (let y = 0; y < h; y++) {
        raw[y * (1 + w * 3)] = 0;
        for (let x = 0; x < w; x++) {
          const o = y * (1 + w * 3) + 1 + x * 3;
          if (y < h / 2) { raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0; }
          else { raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 255; }
        }
      }
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
      ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
      ]);
    };
    const imgUp = await api('/api/scheduled-posts/upload', {
      method: 'POST',
      body: { fileBase64: makeRedBluePng().toString('base64'), fileName: 'red-blue.png', mimeType: 'image/png' },
    });
    const imgUrl = imgUp.data?.url ?? '';
    check('media test image uploads (201, /api/uploads URL)', imgUp.status === 201 && imgUrl.startsWith('/api/uploads/'), `status=${imgUp.status}, url=${imgUrl}`);
    const capImg = await api('/api/scheduled-posts/auto-caption', {
      method: 'POST',
      body: { productIds: [product.id], lang: 'en', mediaUrls: [imgUrl] },
    });
    const imgAnalysis = capImg.data?.mediaAnalysis;
    const imgOpts = Array.isArray(capImg.data?.options) ? capImg.data.options : [];
    check(
      'image auto-caption analyzes the media (mentions red/blue)',
      capImg.status === 200 && imgAnalysis?.mediaType === 'image' && /red/i.test(imgAnalysis.analysis ?? ''),
      `status=${capImg.status}, analysis=${(imgAnalysis?.analysis ?? '').slice(0, 120)}`,
    );
    check(
      'image auto-caption first option is the vision caption (mentions red, real price ৳1500)',
      imgOpts.length >= 1 && /red/i.test(imgOpts[0] ?? '') && (imgOpts[0] ?? '').includes('1500'),
      `options[0]=${(imgOpts[0] ?? '').slice(0, 120)}`,
    );

    // Small red video (2s, ffmpeg) — inline Gemini video path.
    let smallVidPath = '';
    try {
      smallVidPath = path.join(tmpDir, 'red.mp4');
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', smallVidPath], { timeout: 60000 });
    } catch (e) {
      check('ffmpeg makes the small test video', false, String(e?.message ?? e).slice(0, 200));
    }
    if (smallVidPath && fs.existsSync(smallVidPath)) {
      const vidUp = await api('/api/scheduled-posts/upload', {
        method: 'POST',
        body: { fileBase64: fs.readFileSync(smallVidPath).toString('base64'), fileName: 'red.mp4', mimeType: 'video/mp4' },
      });
      const vidUrl = vidUp.data?.url ?? '';
      check('media test video uploads (201, video)', vidUp.status === 201 && vidUp.data?.mediaType === 'video', `status=${vidUp.status}, url=${vidUrl}`);
      const capVid = await api('/api/scheduled-posts/auto-caption', {
        method: 'POST',
        body: { productIds: [product.id], lang: 'en', mediaUrls: [vidUrl] },
      });
      const vidAnalysis = capVid.data?.mediaAnalysis;
      const vidOpts = Array.isArray(capVid.data?.options) ? capVid.data.options : [];
      check(
        'video auto-caption analyzes the video (mentions red)',
        capVid.status === 200 && vidAnalysis?.mediaType === 'video' && /red/i.test(vidAnalysis.analysis ?? ''),
        `status=${capVid.status}, analysis=${(vidAnalysis?.analysis ?? '').slice(0, 120)}`,
      );
      check(
        'video auto-caption first option is the vision caption (mentions red)',
        vidOpts.length >= 1 && /red/i.test(vidOpts[0] ?? ''),
        `options[0]=${(vidOpts[0] ?? '').slice(0, 120)}`,
      );
    } else {
      check('video auto-caption analyzes the video (mentions red)', false, 'small video was not created');
      check('video auto-caption first option is the vision caption (mentions red)', false, 'small video was not created');
    }

    // Large video (>18 MB) — must go through the Gemini File API path.
    let bigVidPath = '';
    try {
      bigVidPath = path.join(tmpDir, 'big.mp4');
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=640x360:d=30', '-vf', 'noise=alls=40:allf=t+u', '-c:v', 'libx264', '-b:v', '6M', '-pix_fmt', 'yuv420p', bigVidPath], { timeout: 120000 });
    } catch (e) {
      check('ffmpeg makes the large (>18 MB) test video', false, String(e?.message ?? e).slice(0, 200));
    }
    if (bigVidPath && fs.existsSync(bigVidPath)) {
      const bigSize = fs.statSync(bigVidPath).size;
      check('large test video is really over the 18 MB inline limit', bigSize > 18 * 1024 * 1024, `bytes=${bigSize}`);
      const bigUp = await api('/api/scheduled-posts/upload', {
        method: 'POST',
        body: { fileBase64: fs.readFileSync(bigVidPath).toString('base64'), fileName: 'big.mp4', mimeType: 'video/mp4' },
      });
      const bigUrl = bigUp.data?.url ?? '';
      const capBig = await api('/api/scheduled-posts/auto-caption', {
        method: 'POST',
        body: { lang: 'en', mediaUrls: [bigUrl] },
      });
      check(
        'large video auto-caption works via the File API path (mediaAnalysis, video)',
        capBig.status === 200 && capBig.data?.mediaAnalysis?.mediaType === 'video' && typeof capBig.data?.mediaAnalysis?.analysis === 'string' && capBig.data.mediaAnalysis.analysis.length > 10,
        `status=${capBig.status}, analysis=${(capBig.data?.mediaAnalysis?.analysis ?? '').slice(0, 120)}`,
      );
    } else {
      check('large video auto-caption works via the File API path (mediaAnalysis, video)', false, 'large video was not created');
    }

    // Bogus media URL — must fall back to text captions honestly, never
    // fake an analysis.
    const capBad = await api('/api/scheduled-posts/auto-caption', {
      method: 'POST',
      body: { productIds: [product.id], lang: 'bn', mediaUrls: ['https://example.com/does-not-exist-xyz.jpg'] },
    });
    const badOpts = Array.isArray(capBad.data?.options) ? capBad.data.options : [];
    check(
      'bogus media URL falls back to text captions (no fake analysis)',
      capBad.status === 200 && badOpts.length >= 2 && !capBad.data?.mediaAnalysis && typeof capBad.data?.note === 'string' && capBad.data.note.length > 0,
      `status=${capBad.status}, options=${badOpts.length}, note=${(capBad.data?.note ?? '').slice(0, 100)}`,
    );

    // 7. Video post: create with media_type 'video', list shows it, publish works locally.
    const vid = await api('/api/scheduled-posts', {
      method: 'POST',
      body: {
        caption: 'ভিডিও পোস্ট টেস্ট',
        mediaType: 'video',
        mediaUrls: ['https://example.com/sample.mp4'],
        platforms: ['facebook'],
        scheduledAt: new Date(`${day6}T12:00:00+06:00`).toISOString(),
      },
    });
    const vidId = vid.data?.post?.id ?? '';
    check(
      'video post created with media_type video',
      vid.status === 201 && vid.data?.post?.media_type === 'video',
      `status=${vid.status}, media_type=${vid.data?.post?.media_type}`,
    );
    const list2 = await api('/api/scheduled-posts');
    const foundVid = (list2.data?.posts ?? []).find((p) => p.id === vidId);
    check(
      'list shows the video post with media_type video',
      !!foundVid && foundVid.media_type === 'video' && Array.isArray(foundVid.media_urls) && foundVid.media_urls[0] === 'https://example.com/sample.mp4',
      `media_type=${foundVid?.media_type}, media_urls=${JSON.stringify(foundVid?.media_urls ?? [])}`,
    );
    if (vidId) {
      const vpub = await api(`/api/scheduled-posts/${vidId}/publish-now`, { method: 'POST' });
      check(
        'video post without a connected Page fails honestly (media kept for the UI player)',
        vpub.status === 200 && vpub.data?.post?.status === 'failed' && vpub.data?.post?.media_type === 'video' && (vpub.data?.post?.media_urls ?? [])[0] === 'https://example.com/sample.mp4',
        `status=${vpub.data?.post?.status}`,
      );
    } else {
      check('video post without a connected Page fails honestly (media kept for the UI player)', false, 'no video post id');
    }

    // 8. REAL publish against the fake Graph server: connect a Page
    // channel (fake token), then text / image / video posts must publish
    // with Graph's real ids — never a stub id. Likes as the Page must
    // reach Graph too. And a due post must publish when the Schedule
    // list loads (lazy sweep).
    const chan = await api('/api/channels', {
      method: 'POST',
      body: { platform: 'messenger', externalId: '12345', displayName: 'Test Page', token: 'fake-page-token' },
    });
    check(
      'connect test Page channel (messenger, fake token)',
      chan.status === 201 && chan.data?.channel?.status === 'connected',
      `status=${chan.status}, channel=${JSON.stringify(chan.data?.channel ?? chan.data ?? '')}`,
    );

    const mkPost = async (body) => {
      const r = await api('/api/scheduled-posts', { method: 'POST', body });
      return r.data?.post?.id ?? '';
    };
    const tId = await mkPost({ caption: 'আসল প্রকাশ টেস্ট', mediaType: 'text', platforms: ['facebook'], scheduledAt: new Date(`${day6}T13:00:00+06:00`).toISOString() });
    const tpub = await api(`/api/scheduled-posts/${tId}/publish-now`, { method: 'POST' });
    check(
      'real publish: text post gets Graph post id (not stub-)',
      tpub.status === 200 && tpub.data?.post?.status === 'published' && tpub.data?.post?.platform_post_id === '12345_67890',
      `status=${tpub.data?.post?.status}, platform_post_id=${tpub.data?.post?.platform_post_id ?? ''}`,
    );
    check(
      'fake Graph received the feed POST for the text post',
      graphCalls.some((c) => c.path === '/v21.0/12345/feed' && c.body?.message === 'আসল প্রকাশ টেস্ট'),
      `feed calls=${graphCalls.filter((c) => c.path === '/v21.0/12345/feed').length}`,
    );

    const iId = await mkPost({ caption: 'ছবির পোস্ট টেস্ট', mediaType: 'image', mediaUrls: ['https://example.com/pic.jpg'], platforms: ['facebook'], scheduledAt: new Date(`${day6}T14:00:00+06:00`).toISOString() });
    const ipub = await api(`/api/scheduled-posts/${iId}/publish-now`, { method: 'POST' });
    check(
      'real publish: image post gets Graph photo post id',
      ipub.status === 200 && ipub.data?.post?.status === 'published' && ipub.data?.post?.platform_post_id === '12345_67891',
      `status=${ipub.data?.post?.status}, platform_post_id=${ipub.data?.post?.platform_post_id ?? ''}`,
    );
    check(
      'fake Graph received the photos POST with the image URL',
      graphCalls.some((c) => c.path === '/v21.0/12345/photos' && c.body?.url === 'https://example.com/pic.jpg'),
      `photos calls=${graphCalls.filter((c) => c.path === '/v21.0/12345/photos').length}`,
    );

    const vId = await mkPost({ caption: 'ভিডিও আসল প্রকাশ টেস্ট', mediaType: 'video', mediaUrls: ['https://example.com/sample.mp4'], platforms: ['facebook'], scheduledAt: new Date(`${day6}T15:00:00+06:00`).toISOString() });
    const vpub2 = await api(`/api/scheduled-posts/${vId}/publish-now`, { method: 'POST' });
    check(
      'real publish: video post gets Graph video id',
      vpub2.status === 200 && vpub2.data?.post?.status === 'published' && vpub2.data?.post?.platform_post_id === 'video_1',
      `status=${vpub2.data?.post?.status}, platform_post_id=${vpub2.data?.post?.platform_post_id ?? ''}`,
    );

    const likePost = await api(`/api/analytics/page-posts/${encodeURIComponent('12345_67890')}/like`, { method: 'POST' });
    check(
      'like a Page post as the Page reaches Graph',
      likePost.status === 200 && likePost.data?.liked === true,
      `status=${likePost.status}, body=${JSON.stringify(likePost.data ?? '')}`,
    );
    const cmt = await api('/api/comments', {
      method: 'POST',
      body: { platformPostId: '12345_67890', platformCommentId: 'comment_1', body: 'টেস্ট কমেন্ট' },
    });
    const cId = cmt.data?.comment?.id ?? '';
    const likeCmt = cId ? await api(`/api/comments/${cId}/like`, { method: 'POST' }) : { status: 0, data: null };
    check(
      'like a comment as the Page reaches Graph',
      likeCmt.status === 200 && likeCmt.data?.liked === true,
      `status=${likeCmt.status}, body=${JSON.stringify(likeCmt.data ?? '')}`,
    );
    check(
      'fake Graph received both /likes calls',
      graphCalls.some((c) => c.path === '/v21.0/12345_67890/likes') && graphCalls.some((c) => c.path === '/v21.0/comment_1/likes'),
      `likes calls=${graphCalls.filter((c) => c.path.endsWith('/likes')).length}`,
    );

    // Due post (scheduled 2 min ago — inside the 5-min grace) must
    // publish when the Schedule list loads (lazy sweep).
    const dueId = await mkPost({ caption: 'সময়মতো প্রকাশ টেস্ট', mediaType: 'text', platforms: ['facebook'], scheduledAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() });
    const list3 = await api('/api/scheduled-posts');
    const dueRow = (list3.data?.posts ?? []).find((p) => p.id === dueId);
    check(
      'lazy sweep: due post published with Graph id when the list loads',
      !!dueRow && dueRow.status === 'published' && dueRow.platform_post_id === '12345_67890',
      `status=${dueRow?.status}, platform_post_id=${dueRow?.platform_post_id ?? ''}`,
    );
    const failedRow = (list3.data?.posts ?? []).find((p) => p.id === createdIds[0]);
    check(
      'failed post carries its reason (lastError) in the list',
      typeof failedRow?.lastError === 'string' && failedRow.lastError.length > 0,
      `lastError=${String(failedRow?.lastError ?? '')}`,
    );

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length > 0) {
      console.log('Failed:');
      for (const f of failed) console.log(` - ${f.name} — ${f.detail}`);
      console.log('\n--- API log (last 3000 chars) ---');
      console.log(apiLog.slice(-3000));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Verification crashed:', err);
    console.log('\n--- API log (last 3000 chars) ---');
    console.log(apiLog.slice(-3000));
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    if (child.exitCode === null) child.kill('SIGKILL');
    try { fakeGraph.close(); } catch { /* best-effort */ }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // temp dir cleanup is best-effort
    }
  }
}

main();
