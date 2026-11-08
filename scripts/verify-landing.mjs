#!/usr/bin/env node
/**
 * Verification for the rebuilt public landing page (apps/web/app/page.tsx).
 *
 * LIVE checks (real built app, no stubs for the page itself):
 *   - `next start` serves the production build on :3101; GET / returns 200
 *     and the rendered HTML contains every required section (hero, who,
 *     features, how-it-works, pricing with the exact prices ৳499/৳999/৳1999,
 *     trial + ৳50 credit line, signup/login CTAs, footer links).
 *   - Headless Chromium (/opt/meta-chromium/chrome, CDP) loads the page at
 *     a 390px mobile viewport and at 1280px desktop and reports
 *     documentElement.scrollWidth vs innerWidth — a real render check for
 *     horizontal overflow, not a CSS guess. NOTE: the vendored Chromium in
 *     this VM cannot start standalone — it requires the image-owned WebGL
 *     policy supplied by browser-daemon ("Hatch WebGL domain policy is
 *     required for browser startup"), which a subagent cannot provide, so
 *     the overflow check below is the built-HTML + built-CSS audit the
 *     task allows instead: every grid starts at 1 column, every CTA row
 *     stacks on mobile, the root carries overflow-x-hidden, no fixed
 *     pixel widths exist, and the built Tailwind CSS contains the
 *     responsive (sm:/md:/lg:) media queries. It is labelled as static,
 *     not a live render.
 *
 * STATIC checks (source of truth, no server needed):
 *   - No emoji anywhere in page.tsx (Lucide-style SVG icons only).
 *   - Every landing.* i18n key used by page.tsx exists in BOTH the en and
 *     bn dictionaries.
 *   - The logged-in redirect (getToken() -> router.replace("/inbox")) is
 *     still present; no fixed-pixel widths that could overflow mobile.
 *
 * Run from the repo root AFTER `npm run build` in apps/web:
 *   node scripts/verify-landing.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'apps/web');
const PORT = 3101;
const BASE = `http://localhost:${PORT}`;
const CHROME = '/opt/meta-chromium/chrome'; // present but not startable standalone (see header)
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

/** Static responsive audit (built HTML + built CSS) — see header note. */
function staticOverflowAudit(pageSrc, html) {
  const grids = [...pageSrc.matchAll(/grid [^"]*"/g)].map((m) => m[0]);
  const gridOk = grids.length > 0 && grids.every((g) => g.includes('grid-cols-1'));
  check(`responsive audit: all ${grids.length} grids start at 1 column on mobile`, gridOk, grids.filter((g) => !g.includes('grid-cols-1')).join(' | '));
  const ctaRows = [...pageSrc.matchAll(/flex flex-col[^"]*sm:flex-row/g)].length;
  check('responsive audit: CTA rows stack (flex-col) on mobile, row from sm:', ctaRows >= 2, `found ${ctaRows}`);
  check('responsive audit: root carries overflow-x-hidden', pageSrc.includes('overflow-x-hidden'));
  check('responsive audit: no fixed pixel widths / min-widths', !/w-\[\d+px\]/.test(pageSrc) && !/min-w-\[\d+px\]/.test(pageSrc) && !/whitespace-nowrap/.test(pageSrc));
  check('responsive audit: live HTML has no inline width styles', !/style="[^"]*width:/.test(html));
  check('responsive audit: live HTML uses the max-w-6xl container + mobile padding', html.includes('max-w-6xl') && html.includes('px-4'));
  // The built Tailwind CSS must contain the responsive media queries the
  // sm:/md:/lg: classes compile to.
  const cssDir = path.join(WEB, '.next/static/css');
  const cssFiles = fs.existsSync(cssDir) ? fs.readdirSync(cssDir).filter((f) => f.endsWith('.css')) : [];
  const css = cssFiles.map((f) => fs.readFileSync(path.join(cssDir, f), 'utf8')).join('\n');
  check('responsive audit: built CSS contains sm (640px) + md (768px) + lg (1024px) media queries', css.includes('@media (min-width:640px)') && css.includes('@media (min-width:768px)') && css.includes('@media (min-width:1024px)'), `css files: ${cssFiles.join(',') || 'none'}`);
  check('responsive audit: built CSS contains the mobile-first grid-cols-1 + sm:grid-cols-2 rules', css.includes('.grid-cols-1') && css.includes('sm\\:grid-cols-2'));
}

async function main() {
  // ================= Static checks =================
  const pageSrc = fs.readFileSync(path.join(WEB, 'app/page.tsx'), 'utf8');
  // Emoji ranges: emoticons, pictographs, transport, flags, dingbats, misc symbols.
  const emojiRe = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/u;
  check('page.tsx contains no emoji icons', !emojiRe.test(pageSrc));
  check('page.tsx uses the repo Lucide-style Icon component (no emoji, no lucide-react import)', pageSrc.includes('@/components/Icon') && !/from\s+["']lucide-react["']/.test(pageSrc));
  check('logged-in redirect kept: getToken() -> router.replace("/inbox")', pageSrc.includes('getToken()') && pageSrc.includes('router.replace("/inbox")'));
  check('page.tsx has no fixed pixel widths (w-[…px]) that could overflow mobile', !/w-\[\d+px\]/.test(pageSrc) && !/min-w-\[\d+px\]/.test(pageSrc));
  for (const id of ['id="who"', 'id="features"', 'id="how"', 'id="pricing"', 'id="faq"']) {
    check(`page.tsx has section ${id}`, pageSrc.includes(id));
  }
  for (const price of ['৳499', '৳999', '৳1999']) {
    check(`page.tsx has exact price ${price}`, pageSrc.includes(`"${price}"`));
  }

  const dictSrc = fs.readFileSync(path.join(WEB, 'lib/i18n-dict.ts'), 'utf8');
  const enPart = dictSrc.split('export const bn')[0];
  const bnPart = dictSrc.split('export const bn')[1] ?? '';
  const usedKeys = [...new Set([...pageSrc.matchAll(/"landing\.([A-Za-z0-9]+)"/g)].map((m) => `landing.${m[1]}`))];
  const missingEn = usedKeys.filter((k) => !enPart.includes(`"${k}"`));
  const missingBn = usedKeys.filter((k) => !bnPart.includes(`"${k}"`));
  check(`all ${usedKeys.length} landing.* keys used exist in the EN dict`, missingEn.length === 0, missingEn.join(', '));
  check(`all ${usedKeys.length} landing.* keys used exist in the BN dict`, missingBn.length === 0, missingBn.join(', '));
  check('BN dict has no stale "WhatsApp coming soon" claim', !bnPart.includes('WhatsApp শীঘ্রই আসছে'));
  check('EN dict has no stale "WhatsApp is coming soon" claim', !enPart.includes('WhatsApp is coming soon'));

  // ================= Live checks =================
  if (!fs.existsSync(path.join(WEB, '.next/BUILD_ID'))) {
    check('production build exists (.next/BUILD_ID) — run npm run build in apps/web first', false);
    process.exit(1);
  }
  const web = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let webLog = '';
  web.stdout.on('data', (d) => { webLog += d.toString(); });
  web.stderr.on('data', (d) => { webLog += d.toString(); });
  const stopWeb = () => { try { process.kill(-web.pid, 'SIGTERM'); } catch { try { web.kill('SIGTERM'); } catch { /* gone */ } } };
  process.on('exit', stopWeb);
  try {
    const up = await waitForServer();
    check('production server serves / with 200', up, up ? '' : webLog.slice(-600));
    if (!up) return;

    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    check('GET / returns HTML', res.status === 200 && html.includes('<html'));
    const need = [
      ['hero headline', 'Your shop'],
      ['hero subheadline (Bengali AI reply)', 'replies to customers in Bengali'],
      ['who-it-is-for section', 'id="who"'],
      ['who audience: Facebook Page sellers', 'Facebook Page sellers'],
      ['features section', 'id="features"'],
      ['feature: AI replies in Bengali', 'AI replies in Bengali, day and night'],
      ['feature: courier Steadfast + Pathao', 'Steadfast + Pathao courier'],
      ['feature: customer memory', 'Remembers your customers'],
      ['feature: AI on/off control', 'You are always in control'],
      ['how-it-works section', 'id="how"'],
      ['how step 1: connect Facebook Page', 'Connect your Facebook Page'],
      ['how step 3: courier', 'Orders come in'],
      ['pricing section', 'id="pricing"'],
      ['price ৳499', '৳499'],
      ['price ৳999', '৳999'],
      ['price ৳1999', '৳1999'],
      ['most popular plan (Medium)', 'Most popular'],
      ['trial + credit line', '14-day free trial'],
      ['credit amount ৳50', '৳50 free credit'],
      ['no card needed (verified against signup form)', 'No card needed'],
      ['signup CTA', 'href="/signup"'],
      ['login CTA', 'href="/login"'],
      ['FAQ section', 'id="faq"'],
      ['FAQ: card question', 'Do I need a card to start?'],
      ['FAQ: delivery charges', '৳100 inside Dhaka'],
      ['footer CTA', 'Start answering every customer'],
      ['footer link /about', 'href="/about"'],
      ['footer link /contact', 'href="/contact"'],
      ['footer link /terms', 'href="/terms"'],
      ['footer link /privacy', 'href="/privacy"'],
    ];
    for (const [name, needle] of need) check(`live HTML: ${name}`, html.includes(needle));
    check('live HTML contains no emoji', !emojiRe.test(html), 'emoji found in rendered landing HTML');
    check('live HTML contains no "coming soon" for WhatsApp', !html.toLowerCase().includes('whatsapp is coming soon'));

    // Static responsive audit (built HTML + built CSS) — a live headless
    // render was not possible: the vendored Chromium needs the
    // browser-daemon WebGL policy and refuses to start standalone.
    staticOverflowAudit(pageSrc, html);
  } finally {
    stopWeb();
    await sleep(1000);
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
