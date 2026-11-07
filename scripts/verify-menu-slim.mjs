#!/usr/bin/env node
/**
 * Verification for the menu slim-down (2026-11-07, user decision).
 * Local, offline — no calls to graph.facebook.com, no Meta app needed.
 *
 * The menu keeps exactly 22 items + the owner-only Owner Panel:
 *   Inbox, Products, Orders, Customers, Channels, Coupons, Leads, Courier,
 *   Schedule, Post Analysis, Analytics, Reviews, Comments, Teach AI,
 *   Saved Replies, Website Chat, AI Providers, Billing, Plans, Guide,
 *   Team, Setup (+ Owner Panel, owner-only).
 * Removed: Bookings, Broadcasts, Agent Desk, Tickets, Feature Requests,
 * Migration — pages, nav entries, API routers and web API clients.
 * The underlying DB tables stay (migrations untouched, data preserved);
 * the tickets table is still used internally (AI-agent create_ticket
 * tool, analytics counts, webhooks data-deletion, customer merge).
 *
 * Checks:
 * - Nav (Sidebar + NavExtra) contains exactly the 22 kept hrefs + /owner,
 *   each once; none of the 6 removed hrefs appears.
 * - The 6 web page dirs and 6 API route dirs are gone; index.ts mounts
 *   none of the 6 routers.
 * - No in-app link in apps/web points to a removed route (href or
 *   /api/* client call); Guide has no Agent Desk article; Contact /
 *   Privacy / Terms no longer point at a Tickets page; the i18n dict
 *   has no nav keys for removed items.
 * - The production build manifest has the kept routes and none of the
 *   removed ones (run `npm run build` in apps/web first).
 * - Live local API (PGlite): removed APIs return 404; kept APIs return
 *   200; /api/analytics/overview still returns 200 (it reads the
 *   tickets table, proving the table still works).
 *
 * Run from the repo root:  node scripts/verify-menu-slim.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
let token = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi(base) {
  return async function api(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
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

function startApi(port, dataDir, extraEnv = {}) {
  const apiProc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'apps/api'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      USE_PGLITE: 'true',
      PGLITE_DATA_DIR: dataDir,
      JWT_SECRET: 'verify-jwt-secret-0123456789abcdef',
      TOKEN_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      AI_PROVIDER: 'groq',
      GROQ_API_KEY: 'gsk_verify_dummy_key',
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

function readDirRecursive(dir, exts = ['.tsx', '.ts']) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      out.push(...readDirRecursive(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const KEPT_HREFS = [
  '/inbox', '/products', '/orders', '/customers', '/channels', '/coupons',
  '/leads', '/courier', '/schedule', '/post-analysis', '/analytics',
  '/reviews', '/comments', '/teach', '/saved-replies', '/website-chat',
  '/ai-providers', '/billing', '/plans', '/guide', '/team', '/setup',
];
const REMOVED_HREFS = [
  '/bookings', '/broadcasts', '/agent-desk', '/tickets', '/feature-requests', '/migration',
];
const REMOVED_API = [
  '/api/bookings', '/api/broadcasts', '/api/agent-desk/instructions',
  '/api/tickets', '/api/feature-requests', '/api/migration/imports',
];
const KEPT_API = [
  '/api/inbox', '/api/products', '/api/orders', '/api/customers',
  '/api/channels', '/api/coupons', '/api/leads', '/api/scheduled-posts',
  '/api/reviews', '/api/saved-replies', '/api/analytics/overview',
];

async function main() {
  // ---------- Static checks ----------
  const sidebarSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/Sidebar.tsx'), 'utf8');
  const extraSrc = fs.readFileSync(path.join(ROOT, 'apps/web/components/NavExtra.tsx'), 'utf8');
  const combined = sidebarSrc + '\n' + extraSrc;

  const missing = KEPT_HREFS.filter((h) => !combined.includes(`"${h}"`));
  check('nav contains all 22 kept items', missing.length === 0, missing.join(', ') || '22/22 present');
  check('nav still contains the owner-only Owner Panel', combined.includes('"/owner"'));
  const stillThere = REMOVED_HREFS.filter((h) => combined.includes(`"${h}"`));
  check('nav contains none of the 6 removed items', stillThere.length === 0, stillThere.join(', ') || 'none present');
  const dupes = [...KEPT_HREFS, '/owner'].filter(
    (h) => (combined.match(new RegExp(`href: "${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')) || []).length > 1,
  );
  check('each kept menu item appears exactly once', dupes.length === 0, dupes.join(', ') || 'no duplicates');

  for (const page of ['bookings', 'broadcasts', 'agent-desk', 'tickets', 'feature-requests', 'migration']) {
    check(`web page /${page} is deleted`, !fs.existsSync(path.join(ROOT, 'apps/web/app', page)));
    check(`API route dir ${page} is deleted`, !fs.existsSync(path.join(ROOT, 'apps/api/src', page)));
  }

  const indexSrc = fs.readFileSync(path.join(ROOT, 'apps/api/src/index.ts'), 'utf8');
  const mounted = ['ticketsRouter', 'bookingsRouter', 'broadcastsRouter', 'featureRequestsRouter', 'migrationRouter', 'agentDeskRouter']
    .filter((r) => indexSrc.includes(r));
  check('index.ts mounts none of the 6 removed routers', mounted.length === 0, mounted.join(', ') || 'none mounted');

  // No in-app link to a removed route anywhere in the web source.
  const webFiles = readDirRecursive(path.join(ROOT, 'apps/web/app'))
    .concat(readDirRecursive(path.join(ROOT, 'apps/web/components')))
    .concat(readDirRecursive(path.join(ROOT, 'apps/web/lib')));
  const linkHits = [];
  for (const f of webFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const h of REMOVED_HREFS) {
      if (src.includes(`"${h}"`) || src.includes(`'${h}'`) || src.includes(`\`${h}\``)) {
        linkHits.push(`${path.relative(ROOT, f)}:${h}`);
      }
    }
    for (const a of REMOVED_API) {
      if (src.includes(`"${a}`) || src.includes(`'${a}`)) linkHits.push(`${path.relative(ROOT, f)}:${a}`);
    }
  }
  check('no in-app link points to a removed page or API', linkHits.length === 0, linkHits.join(', ') || 'none found');

  const guideSrc = fs.readFileSync(path.join(ROOT, 'apps/web/app/guide/page.tsx'), 'utf8');
  check('Guide has no Agent Desk article', !guideSrc.includes('id: "desk"') && !guideSrc.includes('Agent Desk'));

  for (const f of ['contact', 'privacy', 'terms']) {
    const src = fs.readFileSync(path.join(ROOT, 'apps/web/app', f, 'page.tsx'), 'utf8');
    check(`${f} page no longer points at a Tickets page`, !src.includes('Ticket'), src.includes('Ticket') ? 'still mentions Ticket' : 'clean');
  }

  const dictSrc = fs.readFileSync(path.join(ROOT, 'apps/web/lib/i18n-dict.ts'), 'utf8');
  const navLeft = ['nav.tickets', 'nav.broadcasts', 'nav.bookings', 'nav.migration', 'nav.feature-requests', 'nav.agent-desk']
    .filter((k) => dictSrc.includes(`"${k}"`));
  check('i18n dict has no nav keys for removed items', navLeft.length === 0, navLeft.join(', ') || 'none left');

  // Production build manifest: kept routes present, removed routes absent.
  const manifestPath = path.join(ROOT, 'apps/web/.next/app-path-routes-manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const routes = Object.keys(manifest).map((p) => p.replace(/\/page$/, '') || '/');
    const missingRoutes = KEPT_HREFS.filter((h) => !routes.includes(h));
    check('build manifest has all 22 kept routes', missingRoutes.length === 0, missingRoutes.join(', ') || '22/22 present');
    check('build manifest has the Owner Panel routes', routes.some((r) => r === '/owner'));
    const removedRoutes = REMOVED_HREFS.filter((h) => routes.includes(h));
    check('build manifest has none of the 6 removed routes', removedRoutes.length === 0, removedRoutes.join(', ') || 'none present');
  } else {
    check('build manifest exists (run npm run build first)', false, 'apps/web/.next/app-path-routes-manifest.json missing');
  }

  // ---------- Live API checks (local PGlite) ----------
  const port = 4022;
  const base = `http://localhost:${port}`;
  const dataDir = '.pglite-data-menuslim';
  const run = startApi(port, dataDir, {});
  const api = makeApi(base);
  try {
    const up = await waitForHealth(base);
    check('local API boots', up);
    if (!up) {
      console.log('API log tail:\n' + run.log().slice(-3000));
      return;
    }

    const stamp = Date.now().toString(36);
    const signup = await api('/api/auth/signup', {
      method: 'POST', auth: false,
      body: { name: 'Menu Slim', email: `slim+${stamp}@example.com`, password: 'verify1234', workspaceName: 'Slim Shop' },
    });
    check('signup', signup.status === 201 && !!signup.data?.token, `status=${signup.status}`);
    token = signup.data?.token ?? '';

    for (const a of REMOVED_API) {
      const r = await api(a);
      check(`removed API ${a} returns 404`, r.status === 404, `status=${r.status}`);
    }
    for (const a of KEPT_API) {
      const r = await api(a);
      check(`kept API ${a} returns 200`, r.status === 200, `status=${r.status}`);
    }
    // /api/analytics/overview reads the tickets table — 200 proves the
    // table still works for internal use after the UI + router removal.
    const ov = await api('/api/analytics/overview');
    check('analytics overview 200 (tickets table still works internally)', ov.status === 200, `status=${ov.status}`);
  } finally {
    run.stop();
    await sleep(500);
    try { fs.rmSync(path.join(ROOT, 'apps/api', dataDir), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main().then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}).catch((err) => {
  console.error('Verifier crashed:', err);
  process.exit(1);
});
