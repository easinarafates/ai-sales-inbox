#!/usr/bin/env node
/**
 * Verification for multiple product photos (Worker — product images).
 * Run from the repo root:
 *   node scripts/verify-product-images.mjs
 *
 * Starts its OWN API (tsx, port 4014) on a throwaway PGlite data dir in
 * /tmp, so it never touches the real local database or port 4000.
 * Covers: create product returns images: []; add one photo via base64
 * (1x1 PNG) returns 201 + the image row; list images; product list and
 * detail include the images array; non-image upload rejected (400);
 * invalid URL rejected (400); missing product 404; unauthenticated 401;
 * cross-workspace access 404 (add/list/delete); upload-token without a
 * Blob token answers 503; 10-photo cap (11th rejected 400); delete
 * removes the row and the list shrinks; deleting a missing photo 404.
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
const PORT = Number(process.env.VERIFY_PORT ?? 4014);
const API = `http://localhost:${PORT}`;
const results = [];
let token = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(pathname, { method = 'GET', body, auth = true, useToken = token } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && useToken ? { Authorization: `Bearer ${useToken}` } : {}),
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

// 1x1 transparent PNG (base64, no data: prefix — the endpoint accepts both).
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// "hello" as text/plain base64 — must be rejected (not an image).
const TEXT_B64 = Buffer.from('hello, not an image').toString('base64');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prodimg-verify-'));
  const dataDir = path.join(tmpDir, 'pglite-data');
  const env = {
    ...process.env,
    ...parseEnvFile(path.join(API_DIR, '.env')),
    PORT: String(PORT),
    USE_PGLITE: 'true',
    DATABASE_URL: `file:${dataDir}`,
  };
  // No Blob token in this harness: the base64 path stores on disk, and
  // the upload-token route must answer 503.
  delete env.BLOB_READ_WRITE_TOKEN;
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
    check('API starts on throwaway PGlite DB (product_images table present)', true, `port=${PORT}`);

    const stamp = Date.now();
    const signup = await api('/api/auth/signup', {
      method: 'POST',
      auth: false,
      body: { name: 'Photo Verify', email: `photo-verify+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Photo Verify Shop' },
    });
    check('signup workspace A', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';
    if (!token) throw new Error('no token from signup — cannot continue');

    const signupB = await api('/api/auth/signup', {
      method: 'POST',
      auth: false,
      body: { name: 'Photo Verify B', email: `photo-verify-b+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Photo Verify Shop B' },
    });
    const tokenB = signupB.data?.token ?? '';
    check('signup workspace B (cross-workspace checks)', signupB.status === 201 && !!tokenB, `status=${signupB.status}`);

    // Create a product: ৳1500, stock 5.
    const p1 = await api('/api/products', {
      method: 'POST',
      body: { name: 'শাড়ি', pricePaisa: 150000, size: 'M', stock: 5, description: 'সুতির শাড়ি — লাল' },
    });
    const product = p1.data?.product ?? null;
    check(
      'create product returns images: []',
      p1.status === 201 && !!product?.id && Array.isArray(product?.images) && product.images.length === 0,
      `status=${p1.status}`,
    );
    const productId = product?.id;
    if (!productId) throw new Error('no product id — cannot continue');
    const missingId = '00000000-0000-0000-0000-000000000000';

    // Upload-token without a Blob token must answer 503.
    const tok = await api('/api/products/upload-token', { method: 'POST', body: {} });
    check('upload-token without Blob answers 503', tok.status === 503, `status=${tok.status}`);

    // Unauthenticated access must be 401.
    const noAuthList = await api(`/api/products/${productId}/images`, { auth: false });
    check('list images without auth → 401', noAuthList.status === 401, `status=${noAuthList.status}`);
    const noAuthAdd = await api(`/api/products/${productId}/images`, {
      method: 'POST',
      auth: false,
      body: { url: 'https://example.com/a.jpg' },
    });
    check('add image without auth → 401', noAuthAdd.status === 401, `status=${noAuthAdd.status}`);

    // Missing product → 404.
    const missAdd = await api(`/api/products/${missingId}/images`, {
      method: 'POST',
      body: { url: 'https://example.com/a.jpg' },
    });
    check('add image to missing product → 404', missAdd.status === 404, `status=${missAdd.status}`);
    const missList = await api(`/api/products/${missingId}/images`);
    check('list images of missing product → 404', missList.status === 404, `status=${missList.status}`);

    // Non-image base64 must be rejected.
    const badMime = await api(`/api/products/${productId}/images`, {
      method: 'POST',
      body: { fileBase64: TEXT_B64, fileName: 'hello.txt', mimeType: 'text/plain' },
    });
    check('non-image upload rejected (400)', badMime.status === 400, `status=${badMime.status}`);

    // Invalid URL must be rejected.
    const badUrl = await api(`/api/products/${productId}/images`, {
      method: 'POST',
      body: { url: 'not-a-url' },
    });
    check('invalid image URL rejected (400)', badUrl.status === 400, `status=${badUrl.status}`);
    const nonImageUrl = await api(`/api/products/${productId}/images`, {
      method: 'POST',
      body: { url: 'https://example.com/document.pdf' },
    });
    check('non-image URL rejected (400)', nonImageUrl.status === 400, `status=${nonImageUrl.status}`);

    // Add one photo via base64 (disk fallback locally).
    const add1 = await api(`/api/products/${productId}/images`, {
      method: 'POST',
      body: { fileBase64: PNG_1X1_B64, fileName: 'sari.png', mimeType: 'image/png' },
    });
    const img1 = add1.data?.image ?? null;
    check(
      'add photo via base64 → 201 with image row',
      add1.status === 201 && !!img1?.id && typeof img1?.url === 'string' && img1.url.length > 0,
      `status=${add1.status}, url=${img1?.url ?? ''}`,
    );

    // Register an already-uploaded URL.
    const add2 = await api(`/api/products/${productId}/images`, {
      method: 'POST',
      body: { url: 'https://example.com/photos/sari-2.jpg' },
    });
    const img2 = add2.data?.image ?? null;
    check(
      'register uploaded URL → 201',
      add2.status === 201 && !!img2?.id && img2?.url === 'https://example.com/photos/sari-2.jpg',
      `status=${add2.status}`,
    );

    // List must show both photos.
    const list = await api(`/api/products/${productId}/images`);
    check(
      'list images shows 2 photos',
      list.status === 200 && Array.isArray(list.data?.images) && list.data.images.length === 2,
      `status=${list.status}, count=${list.data?.images?.length}`,
    );

    // Product list + detail must include the images array.
    const all = await api('/api/products');
    const listed = (all.data?.products ?? []).find((p) => p.id === productId);
    check(
      'product list includes images array',
      all.status === 200 && Array.isArray(listed?.images) && listed.images.length === 2,
      `count=${listed?.images?.length}`,
    );
    const detail = await api(`/api/products/${productId}`);
    check(
      'product detail includes images array',
      detail.status === 200 && Array.isArray(detail.data?.product?.images) && detail.data.product.images.length === 2,
      `count=${detail.data?.product?.images?.length}`,
    );

    // Cross-workspace access must be 404 (never leak another shop's product).
    const crossAdd = await api(`/api/products/${productId}/images`, {
      method: 'POST',
      useToken: tokenB,
      body: { url: 'https://example.com/photos/sari-3.jpg' },
    });
    check('cross-workspace add → 404', crossAdd.status === 404, `status=${crossAdd.status}`);
    const crossList = await api(`/api/products/${productId}/images`, { useToken: tokenB });
    check('cross-workspace list → 404', crossList.status === 404, `status=${crossList.status}`);
    const crossDel = await api(`/api/products/${productId}/images/${img1.id}`, {
      method: 'DELETE',
      useToken: tokenB,
    });
    check('cross-workspace delete → 404', crossDel.status === 404, `status=${crossDel.status}`);

    // Fill up to the 10-photo cap (2 already there + 8 more).
    let fillOk = true;
    for (let i = 0; i < 8; i++) {
      const r = await api(`/api/products/${productId}/images`, {
        method: 'POST',
        body: { url: `https://example.com/photos/sari-${i + 3}.jpg` },
      });
      if (r.status !== 201) fillOk = false;
    }
    const full = await api(`/api/products/${productId}/images`);
    check(
      '10 photos total all succeed',
      fillOk && full.data?.images?.length === 10,
      `count=${full.data?.images?.length}`,
    );
    const eleventh = await api(`/api/products/${productId}/images`, {
      method: 'POST',
      body: { url: 'https://example.com/photos/sari-11.jpg' },
    });
    check('11th photo rejected (400, 10-photo cap)', eleventh.status === 400, `status=${eleventh.status}`);

    // Delete one photo: list shrinks to 9.
    const del = await api(`/api/products/${productId}/images/${img1.id}`, { method: 'DELETE' });
    check('delete photo → 200', del.status === 200 && !!del.data?.deleted?.id, `status=${del.status}`);
    const afterDel = await api(`/api/products/${productId}/images`);
    check(
      'list shrinks to 9 after delete',
      afterDel.status === 200 && afterDel.data?.images?.length === 9,
      `count=${afterDel.data?.images?.length}`,
    );
    const delMissing = await api(`/api/products/${productId}/images/${img1.id}`, { method: 'DELETE' });
    check('delete missing photo → 404', delMissing.status === 404, `status=${delMissing.status}`);

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
