// Verifier: UI/UX redesign — nav completeness, design tokens, WhatsApp copy.
// Run: node scripts/verify-redesign.mjs  (from apps/web)
// Exit 0 only when every check passes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(webDir, "app");
let pass = 0;
let fail = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

// 1. Every one of the 22 previous routes + Dashboard exists as a page.
const ROUTES = [
  "inbox", "products", "orders", "customers", "channels", "coupons", "leads",
  "courier", "schedule", "post-analysis", "analytics", "reviews", "comments",
  "teach", "saved-replies", "website-chat", "ai-providers", "billing", "plans",
  "guide", "team", "setup", "owner", "dashboard",
];
for (const r of ROUTES) {
  const page = path.join(appDir, r, "page.tsx");
  check(`route /${r} exists`, fs.existsSync(page));
}

// 2. Every route is linked from the Sidebar.
const sidebar = fs.readFileSync(path.join(webDir, "components", "Sidebar.tsx"), "utf8");
for (const r of ROUTES) {
  check(`sidebar links /${r}`, sidebar.includes(`"/${r}"`));
}

// 3. Design tokens: brand #FF5B2E, white background, light orange #FFF1EA.
const tw = fs.readFileSync(path.join(webDir, "tailwind.config.js"), "utf8");
check("tailwind brand is #FF5B2E", tw.includes("#FF5B2E"));
check("tailwind background is #FFFFFF", /background:\s*"#FFFFFF"/.test(tw));
check("tailwind orange-50 is #FFF1EA", tw.includes('50: "#FFF1EA"'));
const css = fs.readFileSync(path.join(appDir, "globals.css"), "utf8");
check("globals body background is white", css.includes("background-color: #ffffff"));
check("globals card border is #eeeeee", css.includes("border-[#eeeeee]"));

// 4. No old coral/teal palette left in the web app.
const allFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx|ts|css)$/.test(e.name)) allFiles.push(p);
  }
}) (path.join(webDir, "app"));
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(e.name)) allFiles.push(p);
  }
})(path.join(webDir, "components"));
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(e.name)) allFiles.push(p);
  }
})(path.join(webDir, "lib"));
let oldPalette = [];
for (const f of allFiles) {
  const src = fs.readFileSync(f, "utf8");
  if (/#ff6a4d|#fff8f3|#e04e33/i.test(src)) oldPalette.push(path.relative(webDir, f));
  if (/teal-\d+/.test(src)) oldPalette.push(`${path.relative(webDir, f)} (teal class)`);
}
check("no old coral/teal palette left", oldPalette.length === 0, oldPalette.join(", "));

// 5. WhatsApp card is WhatsApp-first (dict + page fallback).
const dict = fs.readFileSync(path.join(webDir, "lib", "i18n-dict.ts"), "utf8");
const waEn = dict.match(/"channels\.whatsappDesc": "([^"]*)"/);
check(
  "WhatsApp EN desc is WhatsApp-first",
  !!waEn && waEn[1].startsWith("Connect your WhatsApp Business number"),
  waEn ? waEn[1].slice(0, 60) : "missing",
);
const waBn = dict.match(/"channels\.whatsappDesc": "([^"]*)"/g);
check(
  "WhatsApp BN desc does not start with Facebook",
  !!waBn && waBn.length >= 2 && !waBn[1].includes("Facebook দিয়ে লগইন করে"),
  waBn && waBn[1] ? waBn[1].slice(0, 60) : "missing",
);
check("WhatsApp secondary note exists (EN)", dict.includes("channels.whatsappNote") && dict.includes("Sign-in happens with Facebook"));
const channelsPage = fs.readFileSync(path.join(appDir, "channels", "page.tsx"), "utf8");
check(
  "Channels page WhatsApp fallback is WhatsApp-first",
  channelsPage.includes("Connect your WhatsApp Business number"),
);
check(
  "Channels page WhatsApp fallback has no Facebook-first WhatsApp text",
  !channelsPage.includes("Facebook দিয়ে লগইন করে তোমার WhatsApp Business নম্বরটি"),
);
check("Instagram card stays Facebook-first", channelsPage.includes("Log in with Facebook and pick the Instagram account"));

// 6. Inbox spec pieces: banner, stat cards, tabs, empty state.
const inbox = fs.readFileSync(path.join(appDir, "inbox", "page.tsx"), "utf8");
check("Inbox has welcome banner", inbox.includes("bannerTitle") && inbox.includes("Customer Inbox"));
check("Inbox has 4 stat cards (total/open/pending/closed)", inbox.includes("statTotal") && inbox.includes("statOpen") && inbox.includes("statPending") && inbox.includes("statClosed"));
check("Inbox stats come from the unfiltered list", inbox.includes("loadStats") && inbox.includes("inboxApi.list()"));
check("Inbox has status tabs All/Open/Pending/Closed", inbox.includes('"all"') && inbox.includes('"pending"') && inbox.includes('"closed"'));
check("Inbox empty state says Select a conversation", inbox.includes("Select a conversation"));
check("Inbox search button is green", inbox.includes("btn-green"));
check("Inbox pending maps to snoozed, closed maps to done", inbox.includes('"snoozed"') && inbox.includes('"done"'));

// 7. Sidebar + header per spec.
check("Sidebar is 270px", sidebar.includes("w-[270px]"));
check("Sidebar has brand subtitle", sidebar.includes("AI Chat, Sales & Customer Support"));
check("Sidebar has workspace card", sidebar.includes("AI Sales Workspace"));
check("Sidebar Posts & Analytics has sub-items", sidebar.includes("POSTS_SUB") && sidebar.includes("/schedule") && sidebar.includes("/post-analysis") && sidebar.includes("/analytics"));
const shell = fs.readFileSync(path.join(webDir, "components", "AppShell.tsx"), "utf8");
check("Header is 60px with bottom border", shell.includes("h-[60px]") && shell.includes("border-b"));
check("Header has bell + help", shell.includes('"bell"') && shell.includes('"/guide"'));
check("Header shows page title", shell.includes("TITLES"));

// 8. Orders A-to-Z fields intact (never regress the a1a2cdf5 work).
const ordersPage = fs.readFileSync(path.join(appDir, "orders", "page.tsx"), "utf8");
const orderDetail = fs.readFileSync(path.join(appDir, "orders", "[id]", "page.tsx"), "utf8");
for (const needle of ["customerPhone", "deliveryAddress", "customerName"]) {
  check(`orders list keeps ${needle}`, ordersPage.includes(needle));
}
for (const needle of ["customerPhone", "deliveryAddress", "customerName", "orderItemsOf", "conversation"]) {
  check(`order detail keeps ${needle}`, orderDetail.includes(needle));
}

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
