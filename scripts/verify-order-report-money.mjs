#!/usr/bin/env node
/**
 * Verification for the Orders Report money summary (2026-11-09, user request).
 *
 * GAP: the Orders Report tab showed COUNTS only (orders / delivered /
 * cancelled / returned / damaged) plus one item-only "Order value" for
 * today. It never showed the money per category: how much was damaged,
 * the total value, how much was cancelled, how much money was lost.
 *
 * WHAT WAS ADDED:
 *  1. API GET /api/orders/report now also returns `todayMoney` and
 *     `overall` — a per-category { count, valuePaisa } breakdown where
 *     valuePaisa is the TRUE grand total per order (total_paisa +
 *     delivery_charge_paisa). loss = cancelled + damaged + returned.
 *     inProgress = every order not in an end state, so the rows
 *     reconcile: delivered + cancelled + damaged + returned +
 *     inProgress = total. The old `today` shape is untouched (an
 *     existing verifier pins today.valuePaisa to the item-only sum).
 *  2. Web Report tab shows two money cards (today + overall) with
 *     Bengali labels, each category as COUNT + TAKA, loss in red with
 *     its three parts spelled out.
 *
 * NUMERIC SAFETY: all sums are SQL SUM() on BIGINT, converted with
 * Number() in the API builder — never string-concatenated (the
 * 2026-11-09 orders-total bug: "60000"+"10000" = ৳60,000,100).
 *
 * Checks:
 *  A. Static: the money breakdown exists in API + web, grand-total SQL
 *     is used, no string addition of money values.
 *  B. LIVE deployed API: GET /api/orders returns the 9 known orders;
 *     expected overall + per-day (Dhaka) money is computed from those
 *     live orders and compared against GET /api/orders/report
 *     (todayMoney + overall). Reconciliation is checked on the API
 *     response itself. All money fields must be JSON numbers.
 *
 * Run from the repo root:  node scripts/verify-order-report-money.mjs
 * Prints PASS/FAIL per step and exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

// Expected grand totals (items + delivery) for the 9 known live orders,
// from the user's screenshot brief, cross-checked against live Neon.
const EXPECTED_ORDERS = {
  'ASI-0001': { status: 'pending', grand: 40000 },
  'ASI-0002': { status: 'pending', grand: 50000 },
  'ASI-0003': { status: 'delivered', grand: 40000 },
  'ASI-0004': { status: 'delivered', grand: 60000 },
  'ASI-0005': { status: 'cancelled', grand: 60000 },
  'ASI-0006': { status: 'cancelled', grand: 60000 },
  'ASI-0007': { status: 'cancelled', grand: 50000 },
  'ASI-0008': { status: 'delivered', grand: 70000 },
  'ASI-0011': { status: 'in_transit', grand: 63000 },
};

// Expected OVERALL money (paisa) — must reconcile:
// 170000 delivered + 170000 cancelled + 0 damaged + 0 returned +
// 153000 in-progress (90000 pending + 63000 in courier) = 493000 total.
const EXPECTED_OVERALL = {
  total: { count: 9, valuePaisa: 493000 },
  delivered: { count: 3, valuePaisa: 170000 },
  cancelled: { count: 3, valuePaisa: 170000 },
  damaged: { count: 0, valuePaisa: 0 },
  returned: { count: 0, valuePaisa: 0 },
  loss: { count: 3, valuePaisa: 170000 },
  pending: { count: 2, valuePaisa: 90000 },
  inCourier: { count: 1, valuePaisa: 63000 },
  inProgress: { count: 3, valuePaisa: 153000 },
};

// Expected per-day money (Dhaka dates), from the same live orders.
// 2026-11-08: ASI-0003/0004/0005/0006/0007/0008/0011 (7 orders).
// 2026-11-07: ASI-0001/0002 (2 orders, both pending).
const EXPECTED_DAY = {
  '2026-11-08': {
    total: { count: 7, valuePaisa: 403000 },
    delivered: { count: 3, valuePaisa: 170000 },
    cancelled: { count: 3, valuePaisa: 170000 },
    damaged: { count: 0, valuePaisa: 0 },
    returned: { count: 0, valuePaisa: 0 },
    loss: { count: 3, valuePaisa: 170000 },
    pending: { count: 0, valuePaisa: 0 },
    inCourier: { count: 1, valuePaisa: 63000 },
    inProgress: { count: 1, valuePaisa: 63000 },
  },
  '2026-11-07': {
    total: { count: 2, valuePaisa: 90000 },
    delivered: { count: 0, valuePaisa: 0 },
    cancelled: { count: 0, valuePaisa: 0 },
    damaged: { count: 0, valuePaisa: 0 },
    returned: { count: 0, valuePaisa: 0 },
    loss: { count: 0, valuePaisa: 0 },
    pending: { count: 2, valuePaisa: 90000 },
    inCourier: { count: 0, valuePaisa: 0 },
    inProgress: { count: 2, valuePaisa: 90000 },
  },
};

const END_STATES = ['delivered', 'cancelled', 'damaged', 'returned'];

function buildBreakdown(orders) {
  const byStatus = new Map();
  for (const o of orders) {
    const s = o.status;
    const cur = byStatus.get(s) ?? { count: 0, valuePaisa: 0 };
    cur.count += 1;
    cur.valuePaisa += Number(o.total_paisa ?? 0) + Number(o.delivery_charge_paisa ?? 0);
    byStatus.set(s, cur);
  }
  const cat = (s) => byStatus.get(s) ?? { count: 0, valuePaisa: 0 };
  const sum = (...cs) => cs.reduce((a, c) => ({ count: a.count + c.count, valuePaisa: a.valuePaisa + c.valuePaisa }), { count: 0, valuePaisa: 0 });
  const total = sum(...byStatus.values());
  const delivered = cat('delivered');
  const cancelled = cat('cancelled');
  const damaged = cat('damaged');
  const returned = cat('returned');
  return {
    total,
    delivered,
    cancelled,
    damaged,
    returned,
    loss: sum(cancelled, damaged, returned),
    pending: cat('pending'),
    inCourier: cat('in_transit'),
    inProgress: sum(...[...byStatus.entries()].filter(([s]) => !END_STATES.includes(s)).map(([, v]) => v)),
  };
}

function breakdownEqual(a, b) {
  if (!a || !b) return false;
  return Object.keys(b).every((k) => a[k] && a[k].count === b[k].count && Number(a[k].valuePaisa) === b[k].valuePaisa);
}

function breakdownStr(b) {
  if (!b) return 'missing';
  return Object.entries(b).map(([k, v]) => `${k}=${v.count}×৳${(Number(v.valuePaisa) / 100).toFixed(2)}`).join(' ');
}

function dhakaDate(iso) {
  return new Date(new Date(iso).getTime() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ---------- A. Static checks ----------
const routesSrc = read('apps/api/src/orders/routes.ts');
check('A1 api report: buildMoneyBreakdown exists',
  routesSrc.includes('function buildMoneyBreakdown'));
check('A2 api report: grand total SQL sums total + delivery charge',
  routesSrc.includes('COALESCE(total_paisa, 0) + COALESCE(delivery_charge_paisa, 0)'));
check('A3 api report: returns todayMoney + overall',
  routesSrc.includes('todayMoney') && routesSrc.includes('overall = buildMoneyBreakdown') && routesSrc.includes('todayMoney,'));
check('A4 api report: loss = cancelled + damaged + returned',
  routesSrc.includes('const loss = sum(cancelled, damaged, returned)'));
check('A5 api report: old today shape untouched (valuePaisa = item-only sum)',
  routesSrc.includes("COALESCE(SUM(total_paisa), 0)::text AS value") && routesSrc.includes('today.valuePaisa += Number(r.value)'));
const apiTs = read('apps/web/lib/api.ts');
check('A6 web api: MoneyBreakdown type exported + report() returns todayMoney/overall',
  apiTs.includes('export interface MoneyBreakdown') && apiTs.includes('todayMoney: MoneyBreakdown') && apiTs.includes('overall: MoneyBreakdown'));
const pageSrc = read('apps/web/app/orders/page.tsx');
check('A7 web orders page: MoneyBreakdownGrid renders count + taka per category',
  pageSrc.includes('function MoneyBreakdownGrid') && pageSrc.includes('fmtTaka(cat.valuePaisa)') && pageSrc.includes('fmtNum(cat.count)'));
check('A8 web orders page: today + overall money cards in the Report view',
  pageSrc.includes('report.todayMoney') && pageSrc.includes('report.overall') && pageSrc.includes('MoneyBreakdownGrid breakdown={report.todayMoney}') && pageSrc.includes('MoneyBreakdownGrid breakdown={report.overall}'));
check('A9 web orders page: loss shown with its parts (cancelled + damaged + returned)',
  pageSrc.includes('moneyLossNote') && pageSrc.includes('breakdown.cancelled.valuePaisa') && pageSrc.includes('breakdown.damaged.valuePaisa') && pageSrc.includes('breakdown.returned.valuePaisa'));
check('A10 web orders page: Bengali labels for the money rows',
  pageSrc.includes('মোট ভ্যালু') && pageSrc.includes('মোট লস') && pageSrc.includes('ক্যান্সেল গেছে') && pageSrc.includes('ড্যামেজ') && pageSrc.includes('সব মিলিয়ে টাকার হিসাব'));

// ---------- B. LIVE deployed API ----------
try {
  const mint = await run('node', ['/home/hatch/workspace/.tools/neon-load/mint-live-jwt.js']);
  const token = (mint.out || '').trim();
  if (!token || token.includes(' ')) throw new Error('could not mint live JWT');
  const headers = { Authorization: `Bearer ${token}` };

  const ordersResp = await fetch('https://ai-sales-inbox-api.vercel.app/api/orders', { headers });
  check('B1 live API /api/orders responds 200', ordersResp.status === 200, `status=${ordersResp.status}`);
  let liveOrders = [];
  if (ordersResp.status === 200) {
    const data = await ordersResp.json();
    liveOrders = data.orders ?? [];
    const byNum = Object.fromEntries(liveOrders.map((o) => [o.order_number, o]));
    for (const [num, exp] of Object.entries(EXPECTED_ORDERS)) {
      const o = byNum[num];
      if (!o) { check(`B2 ${num}: present in live API`, false, 'missing'); continue; }
      const grand = Number(o.total_paisa ?? 0) + Number(o.delivery_charge_paisa ?? 0);
      check(`B2 ${num}: live grand total ৳${(grand / 100).toFixed(2)} status=${o.status} (expected ৳${(exp.grand / 100).toFixed(2)} ${exp.status})`,
        grand === exp.grand && o.status === exp.status,
        `total=${o.total_paisa} delivery=${o.delivery_charge_paisa}`);
    }
    // Per-day money computed from the same live orders (Dhaka dates).
    for (const [day, exp] of Object.entries(EXPECTED_DAY)) {
      const dayOrders = liveOrders.filter((o) => dhakaDate(o.created_at) === day);
      const got = buildBreakdown(dayOrders);
      check(`B3 per-day ${day}: money matches (${breakdownStr(got)})`,
        breakdownEqual(got, exp),
        `expected ${breakdownStr(exp)}; orders on that day: ${dayOrders.map((o) => o.order_number).join(',') || 'none'}`);
    }
    // Reconciliation on the computed overall (same math the API uses).
    const overallComputed = buildBreakdown(liveOrders);
    const rec = overallComputed.delivered.valuePaisa + overallComputed.cancelled.valuePaisa + overallComputed.damaged.valuePaisa + overallComputed.returned.valuePaisa + overallComputed.inProgress.valuePaisa;
    check('B4 computed overall reconciles (delivered+cancelled+damaged+returned+inProgress = total)',
      rec === overallComputed.total.valuePaisa && overallComputed.loss.valuePaisa === overallComputed.cancelled.valuePaisa + overallComputed.damaged.valuePaisa + overallComputed.returned.valuePaisa,
      `sum=${rec} total=${overallComputed.total.valuePaisa} loss=${overallComputed.loss.valuePaisa}`);
  }

  const reportResp = await fetch('https://ai-sales-inbox-api.vercel.app/api/orders/report', { headers });
  check('B5 live API /api/orders/report responds 200', reportResp.status === 200, `status=${reportResp.status}`);
  if (reportResp.status === 200) {
    const r = await reportResp.json();
    const dhakaToday = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
    check('B6 report date is today (Dhaka)', r.date === dhakaToday, `date=${r.date} expected=${dhakaToday}`);
    // Old shape still intact.
    check('B7 report today shape intact (orders/delivered/cancelled/returned/damaged/valuePaisa)',
      r.today && typeof r.today.orders === 'number' && typeof r.today.valuePaisa === 'number', JSON.stringify(r.today ?? {}));
    // Money fields are JSON numbers, never strings (the 2026-11-09 bug class).
    const moneyNum = (b) => b && Object.values(b).every((c) => typeof c.count === 'number' && typeof c.valuePaisa === 'number');
    check('B8 report todayMoney + overall are JSON numbers (not strings)',
      moneyNum(r.todayMoney) && moneyNum(r.overall), `todayMoney=${JSON.stringify(r.todayMoney ?? null)}`);
    // Overall must match the expected snapshot AND the live-computed one.
    check('B9 report overall matches expected ৳4,930 (delivered ৳1,700 · cancelled ৳1,700 · loss ৳1,700 · in-courier ৳630 · pending ৳900)',
      breakdownEqual(r.overall, EXPECTED_OVERALL),
      `got ${breakdownStr(r.overall)}`);
    if (liveOrders.length) {
      const overallComputed = buildBreakdown(liveOrders);
      check('B10 report overall matches the live orders list exactly',
        breakdownEqual(r.overall, overallComputed),
        `api=${breakdownStr(r.overall)} computed=${breakdownStr(overallComputed)}`);
    }
    // Today (2026-11-09) has no orders — todayMoney must be honest zeros,
    // which also proves the Dhaka-day window excludes the 11-07/11-08 orders.
    const zero = { count: 0, valuePaisa: 0 };
    const todayZero = r.todayMoney && Object.values(r.todayMoney).every((c) => c.count === 0 && Number(c.valuePaisa) === 0);
    const liveToday = liveOrders.filter((o) => dhakaDate(o.created_at) === dhakaToday);
    check(`B11 report todayMoney is all zeros for ${dhakaToday} (no orders today; live orders today: ${liveToday.length})`,
      liveToday.length === 0 ? todayZero === true : breakdownEqual(r.todayMoney, buildBreakdown(liveToday)),
      `todayMoney=${breakdownStr(r.todayMoney)}`);
    // Reconciliation on the API response itself.
    const o = r.overall;
    const recApi = o && (o.delivered.valuePaisa + o.cancelled.valuePaisa + o.damaged.valuePaisa + o.returned.valuePaisa + o.inProgress.valuePaisa);
    check('B12 report overall reconciles on the API response (parts add to total; loss = cancelled+damaged+returned)',
      !!o && recApi === o.total.valuePaisa && o.loss.valuePaisa === o.cancelled.valuePaisa + o.damaged.valuePaisa + o.returned.valuePaisa,
      `parts sum=${recApi} total=${o?.total?.valuePaisa} loss=${o?.loss?.valuePaisa}`);
  }
} catch (e) {
  check('B live API check', false, String(e.message).slice(0, 200));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
