#!/usr/bin/env node
/**
 * Verification for the policy pages (privacy, terms, about, contact,
 * data-deletion) plus the Terms/Privacy links on signup/login and the
 * landing-page footer links.
 *
 * LIVE checks (real production build, no stubs for the pages themselves):
 *   - `next start` serves the production build on :3102; GET each of
 *     /privacy /terms /about /contact /data-deletion / /signup /login
 *     returns 200, and the rendered HTML contains every required section.
 *   - The landing page footer links to all five policy pages (hrefs present
 *     and each resolves 200).
 *   - The signup form links to /terms + /privacy; the login form links to
 *     /terms + /privacy + /data-deletion.
 *
 * STATIC checks (source of truth, no server needed):
 *   - No placeholder text anywhere in the five policy pages: no
 *     "coming soon", no "lorem ipsum", no "being set up", no
 *     "will be listed here once it is ready".
 *   - The contact email info.yearmedia@gmail.com is present on every page.
 *   - Every page carries a Bengali summary ("সংক্ষেপে").
 *   - Terms names the real payment methods only (bKash / Rocket / Nagad
 *     Send Money + TrxID) — "bank transfer" must not appear.
 *
 * Run from the repo root AFTER `npm run build` in apps/web:
 *   node scripts/verify-policy-pages.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEB = path.join(ROOT, 'apps/web');
const PORT = 3102;
const BASE = `http://localhost:${PORT}`;
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

async function get(route) {
  const res = await fetch(`${BASE}${route}`);
  const body = await res.text();
  return { status: res.status, body };
}

function mustContain(body, needles, label) {
  for (const n of needles) {
    check(`${label} contains "${n}"`, body.includes(n));
  }
}

function mustNotContain(body, needles, label) {
  for (const n of needles) {
    check(`${label} has no "${n}"`, !body.includes(n));
  }
}

const PAGES = ['privacy', 'terms', 'about', 'contact', 'data-deletion'];

async function main() {
  // ---------- Static checks ----------
  const PLACEHOLDERS = ['coming soon', 'lorem ipsum', 'being set up', 'will be listed here once it is ready'];
  for (const p of PAGES) {
    const src = fs.readFileSync(path.join(WEB, 'app', p, 'page.tsx'), 'utf8');
    mustNotContain(src, PLACEHOLDERS, `${p} source`);
    check(`${p} source has contact email`, src.includes('info.yearmedia@gmail.com'));
    check(`${p} source has Bengali summary`, src.includes('সংক্ষেপে'));
  }
  const termsSrc = fs.readFileSync(path.join(WEB, 'app', 'terms', 'page.tsx'), 'utf8');
  check('terms source has no "bank transfer"', !termsSrc.toLowerCase().includes('bank transfer'));
  for (const m of ['bKash', 'Rocket', 'Nagad', 'TrxID']) {
    check(`terms source names payment "${m}"`, termsSrc.includes(m));
  }
  const signupSrc = fs.readFileSync(path.join(WEB, 'app', 'signup', 'page.tsx'), 'utf8');
  check('signup source links /terms', signupSrc.includes('href="/terms"'));
  check('signup source links /privacy', signupSrc.includes('href="/privacy"'));
  const loginSrc = fs.readFileSync(path.join(WEB, 'app', 'login', 'page.tsx'), 'utf8');
  check('login source links /terms', loginSrc.includes('href="/terms"'));
  check('login source links /privacy', loginSrc.includes('href="/privacy"'));
  check('login source links /data-deletion', loginSrc.includes('href="/data-deletion"'));

  // ---------- Live checks ----------
  const server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: WEB, stdio: 'ignore',
  });
  let exitCode = 0;
  try {
    if (!(await waitForServer())) {
      check('production server starts', false, 'next start did not answer on :3102');
      exitCode = 1;
      return;
    }
    check('production server starts', true);

    const pages = {};
    for (const route of [...PAGES, '', 'signup', 'login']) {
      const { status, body } = await get(route === '' ? '/' : `/${route}`);
      const label = route === '' ? 'landing /' : `/${route}`;
      check(`${label} returns 200`, status === 200, `got ${status}`);
      pages[route === '' ? 'landing' : route] = body;
    }

    // Privacy: data collected, why, third parties, cookies, retention, deletion, contact
    mustContain(pages.privacy, [
      'Data we collect', 'Why we use the data', 'Who we share data with',
      'Cookies', 'How long we keep data', 'How to ask for deletion',
      'info.yearmedia@gmail.com', 'Meta', 'Google', 'TikTok',
      'Steadfast', 'Pathao', '30 days', 'Data Deletion', 'সংক্ষেপে',
    ], 'privacy');
    // Terms: plans/prices, trial, payment, refunds, acceptable use, AI disclaimer
    mustContain(pages.terms, [
      'Plans and prices', '৳499', '৳999', '৳1,999', '14-day', '৳50',
      'bKash', 'Rocket', 'Nagad', 'TrxID', 'Refunds', 'Acceptable use',
      'AI assistant', 'Bangladesh', 'info.yearmedia@gmail.com', 'সংক্ষেপে',
    ], 'terms');
    // About: what/who/how/company/contact
    mustContain(pages.about, [
      'What it is', 'Who it is for', 'How it works', 'Year Media',
      'info.yearmedia@gmail.com', 'Steadfast', 'Pathao', '৳100', '৳130',
      'সংক্ষেপে',
    ], 'about');
    // Data deletion: steps + contact + Facebook flow
    mustContain(pages['data-deletion'], [
      'Delete my data', 'info.yearmedia@gmail.com', '30 days',
      'Apps and Websites', 'What gets deleted', 'সংক্ষেপে',
    ], 'data-deletion');
    // Contact: email + what to include + deletion
    mustContain(pages.contact, [
      'info.yearmedia@gmail.com', 'What to include', 'Data deletion',
      'সংক্ষেপে',
    ], 'contact');
    // Landing footer links all five policy pages
    for (const p of PAGES) {
      check(`landing footer links /${p}`, pages.landing.includes(`href="/${p}"`));
    }
    // Signup + login rendered links
    check('signup renders /terms link', pages.signup.includes('href="/terms"'));
    check('signup renders /privacy link', pages.signup.includes('href="/privacy"'));
    check('login renders /terms link', pages.login.includes('href="/terms"'));
    check('login renders /privacy link', pages.login.includes('href="/privacy"'));
    check('login renders /data-deletion link', pages.login.includes('href="/data-deletion"'));
    // No placeholders in any rendered page
    for (const p of [...PAGES, 'landing', 'signup', 'login']) {
      mustNotContain(pages[p], ['coming soon', 'lorem ipsum', 'being set up'], `${p} rendered`);
    }
  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    try { server.kill('SIGKILL'); } catch { /* already dead */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('Failing checks:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Verifier crashed:', err);
  process.exit(2);
});
