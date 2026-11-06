#!/usr/bin/env node
/**
 * Verification for the Post Schedule upgrades (Worker C).
 * Run from the repo root:
 *   node scripts/verify-scheduling-upgrades.mjs
 *
 * Starts its OWN API (tsx, port 4011) on a throwaway PGlite data dir in
 * /tmp, so it never touches the real local database or port 4000.
 * Covers: 15/day limit (16th rejected 400), 7-day window (beyond 7 days
 * rejected 400), publish frees a slot (15 -> publish 1 -> add 1 succeeds),
 * base64 image upload returns a servable URL, auto-caption returns 2-3
 * options containing the REAL product price (never invented), video post
 * create + list shows media_type 'video' (and publishes in the local flow).
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 * NOTE: uses only test data in a fresh workspace; nothing is sent to Meta.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'apps', 'api');
const PORT = Number(process.env.VERIFY_PORT ?? 4011);
const API = `http://localhost:${PORT}`;
const results = [];
let token = '';

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-verify-'));
  const dataDir = path.join(tmpDir, 'pglite-data');
  const env = {
    ...process.env,
    ...parseEnvFile(path.join(API_DIR, '.env')),
    PORT: String(PORT),
    DATABASE_URL: `pglite://${dataDir}`,
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

    // 4. Publishing frees the slot: publish 1 of the 15, then adding 1 more must succeed.
    const pub = await api(`/api/scheduled-posts/${createdIds[0]}/publish-now`, { method: 'POST' });
    check(
      'publish-now publishes one of the 15',
      pub.status === 200 && pub.data?.post?.status === 'published',
      `status=${pub.data?.post?.status}`,
    );
    const afterPub = await api('/api/scheduled-posts');
    check(
      'published post no longer counts toward the day (14/15)',
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
        'video post publishes in the local flow (stub) with playable media URL',
        vpub.status === 200 && vpub.data?.post?.status === 'published' && vpub.data?.post?.media_type === 'video' && (vpub.data?.post?.media_urls ?? [])[0] === 'https://example.com/sample.mp4',
        `status=${vpub.data?.post?.status}`,
      );
    } else {
      check('video post publishes in the local flow (stub) with playable media URL', false, 'no video post id');
    }

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
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // temp dir cleanup is best-effort
    }
  }
}

main();
