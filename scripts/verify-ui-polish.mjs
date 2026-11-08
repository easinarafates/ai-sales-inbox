#!/usr/bin/env node
/**
 * Verification for the UI/UX polish pass.
 *
 * Static checks: all 22 app routes still exist as pages AND are listed
 * in the sidebar nav; the polish classes exist in globals.css; no bare
 * "Loading…" <p> and no full-page peach (#FFF1EA) wrapper survive in
 * the app pages; the per-chat usage display (inbox thread header +
 * list line, customers AI-cost column + detail card) is still present
 * in source; the landing page still has its sections and i18n keys.
 *
 * Live checks: `next start` on the production build (apps/web/.next)
 * serves every route with 200, the landing HTML contains the hero,
 * pricing and FAQ copy, and the built chunks still contain the usage
 * labels (EN + BN).
 *
 * Nothing here touches the live site or sends a message: the production
 * build is served locally on port 3100 and the pages are only fetched.
 *
 * Run from the repo root:  node scripts/verify-ui-polish.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'apps/web');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The 22 routes from the menu slim-down (plus the owner-only Owner Panel).
// dir = folder under apps/web/app; href = sidebar link.
const ROUTES = [
  { href: '/dashboard', dir: 'dashboard' },
  { href: '/inbox', dir: 'inbox' },
  { href: '/products', dir: 'products' },
  { href: '/orders', dir: 'orders' },
  { href: '/customers', dir: 'customers' },
  { href: '/courier', dir: 'courier' },
  { href: '/channels', dir: 'channels' },
  { href: '/coupons', dir: 'coupons' },
  { href: '/leads', dir: 'leads' },
  { href: '/schedule', dir: 'schedule' },
  { href: '/post-analysis', dir: 'post-analysis' },
  { href: '/analytics', dir: 'analytics' },
  { href: '/reviews', dir: 'reviews' },
  { href: '/comments', dir: 'comments' },
  { href: '/teach', dir: 'teach' },
  { href: '/saved-replies', dir: 'saved-replies' },
  { href: '/ai-providers', dir: 'ai-providers' },
  { href: '/website-chat', dir: 'website-chat' },
  { href: '/billing', dir: 'billing' },
  { href: '/plans', dir: 'plans' },
  { href: '/setup', dir: 'setup' },
  { href: '/team', dir: 'team' },
  { href: '/guide', dir: 'guide' },
  { href: '/owner', dir: 'owner' },
];

function readRel(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

async function waitForServer(base, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/login`);
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

async function main() {
  // ================= Static: routes + nav =================
  const sidebar = readRel('components/Sidebar.tsx');
  let routesOk = true;
  for (const r of ROUTES) {
    const pageExists = fs.existsSync(path.join(WEB, 'app', r.dir, 'page.tsx'));
    const inNav = sidebar.includes(`href: "${r.href}"`);
    if (!pageExists || !inNav) routesOk = false;
    check(`route ${r.href}: page exists + listed in sidebar nav`, pageExists && inNav, !pageExists ? 'page.tsx missing' : !inNav ? 'not in Sidebar.tsx' : '');
  }
  check('all 22 routes (+ Owner Panel) still exist and are reachable', routesOk);

  // ================= Static: polish classes =================
  const css = readRel('app/globals.css');
  check('globals.css defines .page-title / .page-subtitle', css.includes('.page-title') && css.includes('.page-subtitle'));
  check('globals.css defines .empty-state / .skeleton / .card / .btn-primary', css.includes('.empty-state') && css.includes('.skeleton') && css.includes('.card') && css.includes('.btn-primary'));
  const tw = readRel('tailwind.config.js');
  check('design-spec colours kept (#FF5B2E brand, #FFF1EA light orange, #EEEEEE borders)', tw.includes('#FF5B2E') && tw.includes('#FFF1EA') && css.includes('#eeeeee'));

  // ================= Static: no bare loading text / peach wrappers left =================
  const appPages = [];
  const collect = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (e.name === 'page.tsx') appPages.push(p);
    }
  };
  collect(path.join(WEB, 'app'));
  const bareLoading = [];
  const peachWrappers = [];
  for (const p of appPages) {
    const src = fs.readFileSync(p, 'utf8');
    if (/<p className="text-slate-500">\{t\("(common\.)?loading"/.test(src)) bareLoading.push(path.relative(WEB, p));
    if (src.includes('bg-[#FFF1EA] min-h-screen -m-6 p-6')) peachWrappers.push(path.relative(WEB, p));
  }
  check('no bare "Loading…" <p> left in app pages (skeletons instead)', bareLoading.length === 0, bareLoading.join(', '));
  check('no full-page peach wrapper left in app pages (white spec)', peachWrappers.length === 0, peachWrappers.join(', '));

  // Page titles use the shared class (ad-hoc h1 styles are gone from app pages).
  const adHocH1 = appPages.filter((p) => {
    const src = fs.readFileSync(p, 'utf8');
    return /<h1 className="text-2xl font-bold (mb-1|mb-4|my-4)">/.test(src);
  });
  check('no ad-hoc page h1 left (all use .page-title)', adHocH1.length === 0, adHocH1.map((p) => path.relative(WEB, p)).join(', '));

  // ================= Static: usage display still present =================
  const inboxSrc = readRel('app/inbox/page.tsx');
  check('inbox: thread-header usage line present (AI usage so far)', inboxSrc.includes('inbox.aiUsageTitle') && inboxSrc.includes('usageByConv'));
  check('inbox: conversation-list usage line present', inboxSrc.includes('AI ·') && inboxSrc.includes('aiUsageReplies'));
  const custSrc = readRel('app/customers/page.tsx');
  check('customers list: AI cost column present', custSrc.includes('customers.thAiCost') && custSrc.includes('usageByCustomer'));
  const custDetailSrc = readRel('app/customers/[id]/page.tsx');
  check('customer detail: AI usage card with per-chat breakdown present', custDetailSrc.includes('customers.aiUsageTitle') && custDetailSrc.includes('customers.aiUsagePerChat'));

  // ================= Static: landing still present =================
  const landingSrc = readRel('app/page.tsx');
  check('landing: hero + features + pricing + FAQ sections present', landingSrc.includes('landing.heroTitle') && landingSrc.includes('landing.featuresNav') && landingSrc.includes('landing.pricingNav') && landingSrc.includes('landing.faq1Q'));
  const dictSrc = readRel('lib/i18n-dict.ts');
  check('landing i18n keys present (EN + BN)', dictSrc.includes('"landing.heroTitle": "Your shop\'s messages, answered by AI') && dictSrc.includes('"landing.heroTitle": "আপনার শপের মেসেজের উত্তর দেবে AI'));
  check('landing pricing still ৳499 / ৳999 / ৳1999', landingSrc.includes('৳499') && landingSrc.includes('৳999') && landingSrc.includes('৳1999'));

  // ================= Live: production build serves every route =================
  check('production build exists (.next/BUILD_ID)', fs.existsSync(path.join(WEB, '.next', 'BUILD_ID')));
  const port = 3100;
  const base = `http://localhost:${port}`;
  const server = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: WEB,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, NODE_ENV: 'production' },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d.toString(); });
  server.stderr.on('data', (d) => { serverLog += d.toString(); });
  const stop = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* already gone */ } } };
  process.on('exit', stop);
  try {
    const up = await waitForServer(base);
    check('production server starts (next start, /login 200)', up, up ? '' : serverLog.slice(-500));
    if (!up) return;

    let all200 = true;
    for (const r of [{ href: '/', dir: 'landing' }, ...ROUTES]) {
      let status = 0;
      let body = '';
      try {
        const res = await fetch(`${base}${r.href}`);
        status = res.status;
        body = await res.text();
      } catch (err) {
        status = 0;
        body = '';
      }
      const ok = status === 200 && body.length > 500;
      if (!ok) all200 = false;
      check(`GET ${r.href} → 200 from production build`, ok, `status=${status}, bytes=${body.length}`);
    }
    check('every route renders 200 (no page fails to render)', all200);

    const homeRaw = await (await fetch(`${base}/`)).text();
    // React escapes apostrophes in the served HTML (&#x27;).
    const home = homeRaw.replace(/&#x27;|&#39;/g, "'");
    check('landing HTML has the hero title', home.includes("Your shop's messages, answered by AI") || home.includes('আপনার শপের মেসেজের উত্তর দেবে AI'), 'hero title not in served HTML');
    check('landing HTML has pricing ৳499 / ৳999 / ৳1999', home.includes('৳499') && home.includes('৳999') && home.includes('৳1999'));
    check('landing HTML has the FAQ section', home.includes('id="faq"') && home.includes('Do I need a card to start?'));

    // Built chunks still carry the usage display strings.
    const chunksDir = path.join(WEB, '.next', 'static', 'chunks');
    const chunks = fs.existsSync(chunksDir) ? walkJs(chunksDir) : [];
    const bundle = chunks.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    check('built bundle contains the EN usage labels', bundle.includes('AI usage so far') && bundle.includes('AI cost'));
    check('built bundle contains the BN usage labels', bundle.includes('এখন পর্যন্ত AI ব্যবহার') && bundle.includes('AI খরচ'));
    check('built bundle still calls /api/inbox/usage', bundle.includes('/api/inbox/usage'));
  } finally {
    stop();
    await sleep(2000);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`);
  if (failed.length > 0) {
    console.log('Failed checks:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(1);
});
