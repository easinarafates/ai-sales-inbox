#!/usr/bin/env node
/**
 * Site-audit verification (local, no Docker).
 * Run while the API is up on :4000 and the web app on :3000:
 *   USE_PGLITE=true node scripts/run-local.sh   (or start both yourself)
 *   node scripts/verify-site-audit.mjs
 *
 * Covers the fixes from the 2026-11-07 full-site audit:
 *  - every web route returns 200 (incl. new /terms, /about, /contact)
 *  - signup free-credit wallet row carries a description
 *  - products: PATCH update + DELETE work, GET reflects the update
 *  - scheduled posts: non-Facebook platforms are rejected at create
 *  - POST /api/billing/topup is 403 without the test-hooks flag
 *  - tickets accept a missing conversation (picker, not a raw UUID)
 *  - knowledge preview returns aiGenerated; versions list + rollback work
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 * Uses only test data in a fresh workspace; nothing is sent to Meta.
 */
import fs from 'node:fs';

const API = process.env.API_URL ?? 'http://localhost:4000';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const results = [];
let token = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${API}${path}`, {
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

async function webGet(path) {
  const res = await fetch(`${WEB}${path}`);
  await res.text();
  return res.status;
}

const PAGES = [
  '/', '/login', '/signup', '/forgot-password', '/reset-password',
  '/privacy', '/terms', '/about', '/contact', '/plans', '/guide',
  '/inbox', '/products', '/orders', '/customers', '/schedule', '/billing',
  '/analytics', '/comments', '/post-analysis', '/channels', '/coupons',
  '/leads', '/bookings', '/courier', '/broadcasts', '/reviews', '/tickets',
  '/feature-requests', '/teach', '/saved-replies', '/agent-desk',
  '/ai-providers', '/website-chat', '/setup', '/team', '/migration',
  '/owner', '/owner/shops', '/owner/wallet', '/owner/bank-accounts',
  '/owner/expenses', '/owner/api-costs',
];

const stamp = Date.now();
const email = `site-audit-${stamp}@yearmedia.xyz`;

(async () => {
  // --- auth: fresh workspace -------------------------------------------
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    auth: false,
    body: { name: 'Site Audit', email, password: 'audit-pass-123', workspaceName: 'Site Audit Shop' },
  });
  check('signup creates workspace', signup.status === 201, `status=${signup.status}`);
  token = signup.data?.token ?? signup.data?.user?.token ?? '';
  if (!token) {
    const login = await api('/api/auth/login', {
      method: 'POST', auth: false, body: { email, password: 'audit-pass-123' },
    });
    token = login.data?.token ?? '';
  }
  check('login token issued', !!token);

  // --- billing: free-credit description --------------------------------
  const billing = await api('/api/billing');
  const txs = billing.data?.transactions ?? billing.data?.billing?.transactions ?? [];
  const credit = Array.isArray(txs) ? txs.find((x) => (x.type ?? x.Type) === 'topup') : null;
  check('billing loads', billing.status === 200, `status=${billing.status}`);
  check(
    'free-credit transaction has a description',
    !!credit && typeof credit.description === 'string' && credit.description.length > 0,
    `description=${JSON.stringify(credit?.description ?? null)}`,
  );

  // --- billing: direct top-up must be 403 without the test flag --------
  const topup = await api('/api/billing/topup', { method: 'POST', body: { amountPaisa: 10000 } });
  check('direct top-up is 403 without test-hooks flag', topup.status === 403, `status=${topup.status}`);

  // --- products: create -> PATCH -> GET -> DELETE -----------------------
  const created = await api('/api/products', {
    method: 'POST',
    body: { name: 'Audit Shirt', pricePaisa: 60000, size: 'M', stock: 5, description: 'audit' },
  });
  const product = created.data?.product ?? created.data;
  check('product created', created.status === 201 && !!product?.id, `status=${created.status}`);
  const pid = product?.id;
  if (pid) {
    const patched = await api(`/api/products/${pid}`, {
      method: 'PATCH',
      body: { name: 'Audit Shirt v2', pricePaisa: 75000, stock: 7 },
    });
    const p2 = patched.data?.product ?? patched.data;
    check(
      'product PATCH updates name+price+stock',
      patched.status === 200 && p2?.name === 'Audit Shirt v2' && (p2?.price_paisa ?? p2?.pricePaisa) === 75000,
      `status=${patched.status} name=${p2?.name} price=${p2?.price_paisa ?? p2?.pricePaisa}`,
    );
    const got = await api(`/api/products/${pid}`);
    const g = got.data?.product ?? got.data;
    check('product GET reflects the update', got.status === 200 && g?.name === 'Audit Shirt v2', `name=${g?.name}`);
    const badPatch = await api(`/api/products/${pid}`, { method: 'PATCH', body: { pricePaisa: -5 } });
    check('product PATCH rejects negative price', badPatch.status === 400, `status=${badPatch.status}`);
    const deleted = await api(`/api/products/${pid}`, { method: 'DELETE' });
    check('product DELETE works', deleted.status === 200 && deleted.data?.deleted === true, `status=${deleted.status}`);
    const gone = await api(`/api/products/${pid}`);
    check('deleted product GETs 404', gone.status === 404, `status=${gone.status}`);
  }

  // --- schedule: platform guard -----------------------------------------
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const badPlatform = await api('/api/scheduled-posts', {
    method: 'POST',
    body: { caption: 'audit ig', mediaType: 'text', platforms: ['instagram'], scheduledAt: `${day}T10:00:00+06:00` },
  });
  check(
    'scheduled post with instagram is rejected',
    badPlatform.status === 400 && /facebook/i.test(badPlatform.data?.error ?? ''),
    `status=${badPlatform.status} error=${JSON.stringify(badPlatform.data?.error ?? null)}`,
  );
  const badMessenger = await api('/api/scheduled-posts', {
    method: 'POST',
    body: { caption: 'audit ms', mediaType: 'text', platforms: ['messenger'], scheduledAt: `${day}T10:00:00+06:00` },
  });
  check('scheduled post with messenger is rejected', badMessenger.status === 400, `status=${badMessenger.status}`);
  const goodPost = await api('/api/scheduled-posts', {
    method: 'POST',
    body: { caption: 'audit fb', mediaType: 'text', platforms: ['facebook'], scheduledAt: `${day}T11:00:00+06:00` },
  });
  check('scheduled post with facebook is accepted', [200, 201].includes(goodPost.status), `status=${goodPost.status}`);

  // --- tickets: conversation is optional --------------------------------
  const ticket = await api('/api/tickets', {
    method: 'POST',
    body: { reason: 'audit ticket without conversation' },
  });
  check('ticket without conversationId is accepted', [200, 201].includes(ticket.status), `status=${ticket.status}`);

  // --- knowledge: preview flag + versions + rollback --------------------
  const kCreated = await api('/api/knowledge', {
    method: 'POST',
    body: { title: 'Audit info', body: 'Delivery charge is 60 taka.' },
  });
  const kItem = kCreated.data?.knowledgeItem ?? kCreated.data;
  const kid = kItem?.id;
  check('knowledge item created', [200, 201].includes(kCreated.status) && !!kid, `status=${kCreated.status}`);
  if (kid) {
    const preview = await api('/api/knowledge/preview-change', {
      method: 'POST',
      body: { knowledgeId: kid, instruction: 'change the delivery charge to 80 taka' },
    });
    check(
      'preview-change returns aiGenerated flag',
      preview.status === 200 && typeof preview.data?.aiGenerated === 'boolean',
      `status=${preview.status} aiGenerated=${preview.data?.aiGenerated}`,
    );
    const applied = await api('/api/knowledge/apply-change', {
      method: 'POST',
      body: { knowledgeId: kid, newBody: 'Delivery charge is 80 taka.' },
    });
    check('apply-change saves a version', applied.status === 200 && !!applied.data?.versionId, `status=${applied.status}`);
    const versions = await api(`/api/knowledge/${kid}/versions`);
    const vlist = versions.data?.versions ?? [];
    check(
      'versions list returns the saved version',
      versions.status === 200 && Array.isArray(vlist) && vlist.length >= 1,
      `status=${versions.status} count=${vlist.length}`,
    );
    if (vlist.length > 0) {
      const rolled = await api(`/api/knowledge/${kid}/rollback`, {
        method: 'POST',
        body: { versionId: vlist[0].id },
      });
      const rb = rolled.data?.knowledgeItem ?? rolled.data;
      check(
        'rollback restores the earlier body',
        rolled.status === 200 && typeof rb?.body === 'string' && rb.body.includes('60 taka'),
        `status=${rolled.status} body=${JSON.stringify(rb?.body ?? null)}`,
      );
    }
  }

  // --- review request on unknown order is a clean 404 -------------------
  const rr = await api('/api/orders/00000000-0000-0000-0000-000000000000/request-review', { method: 'POST', body: {} });
  check('review request on unknown order is 404', rr.status === 404, `status=${rr.status}`);

  // --- every web route returns 200 --------------------------------------
  let pagesOk = 0;
  const badPages = [];
  for (const p of PAGES) {
    const s = await webGet(p);
    if (s === 200) pagesOk++;
    else badPages.push(`${p}=${s}`);
  }
  check(`all ${PAGES.length} web pages return 200`, badPages.length === 0, badPages.join(', ') || `${pagesOk}/${PAGES.length} ok`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const f of failed) console.log(` - ${f.name}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('verifier crashed:', e);
  process.exit(1);
});
