/**
 * Invoice IMAGE renderer (2026-11-08, user demand).
 *
 * After an order is confirmed the AI must send the customer an INVOICE
 * IMAGE (a picture of the invoice, at the price the order was placed) —
 * not just the invoice link. The previous attempt used @vercel/og /
 * Satori, which BREAKS Bengali conjuncts — do NOT use it. This module
 * renders the invoice as self-contained HTML (the same content as the
 * web invoice page, with the Hind Siliguri font embedded as base64) and
 * screenshots it with headless Chromium (@sparticuz/chromium +
 * puppeteer-core), which renders Bengali correctly (verified by visual
 * inspection of the generated PNG: conjuncts intact).
 *
 * The PNG is uploaded to Vercel Blob by the caller and sent as a
 * Messenger image attachment (deliverOutgoingImageMessage). Rendering
 * is best-effort with a timeout — a failure returns null and the caller
 * logs it honestly; the text confirmation + invoice link still go out,
 * and a broken-Bengali image is NEVER sent.
 */
// NOTE (2026-11-08): @sparticuz/chromium and puppeteer-core are ESM-only
// ("type": "module"). The API is compiled to CommonJS, so a static
// `import` here becomes a `require()` at runtime and CRASHES the whole
// module on Vercel ("require() of ES Module ... not supported") — which
// broke ALL AI replies, not just invoice images. They MUST be loaded with
// a genuine dynamic import() inside the render function (the only place
// they are used), never at the top of this file.
//
// CAREFUL: TypeScript's CommonJS emit rewrites a syntactic `import()` to
// `require()` too (via __importStar), which fails the same way on
// Vercel's Node. So the import is done through the Function constructor:
// it is evaluated at runtime, so the import() survives compilation
// untouched and loads the ESM packages properly.
const dynamicImport = new Function('specifier', 'return import(specifier);') as <T>(
  specifier: string,
) => Promise<T>;
import { INVOICE_FONT_BOLD_B64, INVOICE_FONT_REGULAR_B64 } from './invoice-font';
import { formatTaka } from './bill';
import { PAYMENT_METHOD_BN } from './public-invoice';
import { deliveryEstimateText, zoneOfAddress } from './order-helpers';

export interface InvoiceImageData {
  orderNumber: string;
  shopName: string;
  status: string;
  paymentMethodLabel: string;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  zone: string;
  insideDhaka: boolean;
  items: { name: string; quantity: number; pricePaisa: number; lineTotalPaisa: number }[];
  totalPaisa: number;
  deliveryChargePaisa: number;
  grandTotalPaisa: number;
  grandTotalText: string;
  deliveryEstimate: string;
  createdAt: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Self-contained invoice HTML (no external requests — font embedded). */
export function buildInvoiceHtml(d: InvoiceImageData): string {
  const rows = d.items
    .map(
      (it) =>
        `<tr><td>${esc(it.name)}</td><td class="r">${it.quantity}</td><td class="r">${formatTaka(it.pricePaisa)}</td><td class="r">${formatTaka(it.lineTotalPaisa)}</td></tr>`,
    )
    .join('');
  const dateText = new Date(d.createdAt).toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka' });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'HS';src:url(data:font/ttf;base64,${INVOICE_FONT_REGULAR_B64}) format('truetype');font-weight:400}
@font-face{font-family:'HS';src:url(data:font/ttf;base64,${INVOICE_FONT_BOLD_B64}) format('truetype');font-weight:700}
*{box-sizing:border-box}
body{font-family:'HS',sans-serif;width:640px;margin:0;padding:28px;color:#111;background:#fff}
h1{font-size:26px;font-weight:700;color:#FF5B2E;margin:0}
.sub{font-size:14px;color:#666;margin-top:4px}
.badge{display:inline-block;font-size:12px;background:#dcfce7;color:#166534;border-radius:999px;padding:4px 10px;margin-top:10px}
.sec{margin-top:18px;font-size:15px;line-height:1.7}
.sec b{font-weight:700}
.label{color:#666}
table{width:100%;border-collapse:collapse;margin-top:18px;font-size:15px}
th{text-align:left;color:#666;border-bottom:1px solid #ddd;padding:8px 4px;font-weight:400}
td{border-bottom:1px solid #eee;padding:8px 4px}
.r{text-align:right}
.tot{margin-top:14px;font-size:15px;line-height:1.9}
.tot .grand{font-size:20px;font-weight:700}
.foot{margin-top:18px;border-top:1px solid #ddd;padding-top:12px;font-size:14px;line-height:1.7;color:#333}
.note{font-size:12px;color:#999;margin-top:8px}
</style></head><body>
<h1>${esc(d.shopName)}</h1>
<div class="sub">ইনভয়েস / রসিদ</div>
<div><span class="badge">অর্ডার কনফার্ম করা হয়েছে ✅</span></div>
<div class="sec">
<div><span class="label">অর্ডার নম্বর:</span> <b>${esc(d.orderNumber)}</b></div>
<div><span class="label">তারিখ:</span> ${esc(dateText)}</div>
<div><span class="label">নাম:</span> ${esc(d.customerName ?? '—')}</div>
<div><span class="label">ফোন:</span> ${esc(d.customerPhone ?? '—')}</div>
<div><span class="label">ডেলিভারি ঠিকানা:</span> ${esc(d.deliveryAddress ?? '—')}</div>
<div><span class="label">জোন:</span> ${esc(d.zone)}${d.insideDhaka ? ' (ঢাকার ভেতরে)' : ' (ঢাকার বাইরে)'}</div>
</div>
<table><thead><tr><th>আইটেম</th><th class="r">পরিমাণ</th><th class="r">দাম</th><th class="r">মোট</th></tr></thead><tbody>${rows}</tbody></table>
<div class="tot">
<div>পণ্যের মোট: ${formatTaka(d.totalPaisa)}</div>
<div>ডেলিভারি চার্জ: ${formatTaka(d.deliveryChargePaisa)}</div>
<div class="grand">সর্বমোট: ${d.grandTotalText}</div>
</div>
<div class="foot">
<div><span class="label">পেমেন্ট:</span> ${esc(d.paymentMethodLabel)}</div>
<div><span class="label">আনুমানিক ডেলিভারি:</span> ${esc(d.deliveryEstimate)}</div>
<div class="note">ডেলিভারির তারিখ আনুমানিক — কুরিয়ারের উপর নির্ভর করে একটু এদিক-সেদিক হতে পারে।</div>
</div>
</body></html>`;
}

/** Render invoice HTML to a PNG buffer with headless Chromium. Null on any failure. */
export async function renderInvoiceImagePng(html: string, timeoutMs = 60000): Promise<Buffer | null> {
  // Genuine dynamic import() (see the note at the top of this file).
  // A syntactic import() here would be rewritten to require() by
  // TypeScript's CommonJS emit and fail on Vercel's Node.
  const { default: chromium } = await dynamicImport<typeof import('@sparticuz/chromium')>(
    '@sparticuz/chromium',
  );
  const { default: puppeteer } = await dynamicImport<typeof import('puppeteer-core')>(
    'puppeteer-core',
  );
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      // A short viewport: fullPage screenshots the content height, so a
      // tall viewport would leave a blank band under the invoice.
      defaultViewport: { width: 700, height: 100 },
      executablePath: await chromium.executablePath(),
      headless: 'shell',
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
    // The invoice font is an inline data URI (loads with the page), but
    // wait for the font engine to actually have it ready before the shot.
    await page
      .waitForFunction('document.fonts && document.fonts.status === "loaded"', { timeout: 10000 })
      .catch(() => undefined);
    const png = await page.screenshot({ type: 'png', fullPage: true });
    return Buffer.from(png);
  } catch (err) {
    console.error('[invoice-image] render failed:', (err as Error).message);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

interface InvoiceDb {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

/** Load one order's invoice data (same fields as the public invoice API) and render it to a PNG. Null on any failure. */
export async function renderInvoiceImageForOrder(
  db: InvoiceDb,
  workspaceId: string,
  orderId: string,
): Promise<{ png: Buffer; orderNumber: string; invoiceToken: string } | null> {
  try {
    const { rows } = await db.query<{
      id: string;
      order_number: string;
      invoice_token: string;
      status: string;
      payment_status: string;
      payment_method: string;
      total_paisa: number;
      delivery_charge_paisa: number;
      created_at: string;
      customer_name: string | null;
      customer_phone: string | null;
      delivery_address: string | null;
      shop_name: string;
    }>(
      `SELECT o.id, o.order_number, o.invoice_token, o.status, o.payment_status, o.payment_method,
              o.total_paisa, o.delivery_charge_paisa, o.created_at,
              o.customer_name, o.customer_phone, o.delivery_address,
              w.name AS shop_name
       FROM orders o JOIN workspaces w ON w.id = o.workspace_id
       WHERE o.workspace_id = $1 AND o.id = $2 LIMIT 1`,
      [workspaceId, orderId],
    );
    if (rows.length === 0) return null;
    const o = rows[0];
    const zone = zoneOfAddress(o.delivery_address as string | null);
    const { rows: items } = await db.query<{
      quantity: number;
      price_paisa: number;
      product_name: string | null;
    }>(
      `SELECT oi.quantity, oi.price_paisa, p.name AS product_name
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1 ORDER BY oi.created_at ASC`,
      [o.id],
    );
    const totalPaisa = Number(o.total_paisa ?? 0);
    const deliveryChargePaisa = Number(o.delivery_charge_paisa ?? 0);
    const data: InvoiceImageData = {
      orderNumber: o.order_number,
      shopName: o.shop_name,
      status: o.status,
      paymentMethodLabel: PAYMENT_METHOD_BN[String(o.payment_method ?? 'cod')] ?? o.payment_method,
      customerName: o.customer_name,
      customerPhone: o.customer_phone,
      deliveryAddress: o.delivery_address,
      zone: zone.label,
      insideDhaka: zone.insideDhaka,
      items: items.map((it) => ({
        name: it.product_name ?? 'আইটেম',
        quantity: Number(it.quantity ?? 1),
        pricePaisa: Number(it.price_paisa ?? 0),
        lineTotalPaisa: Number(it.quantity ?? 1) * Number(it.price_paisa ?? 0),
      })),
      totalPaisa,
      deliveryChargePaisa,
      grandTotalPaisa: totalPaisa + deliveryChargePaisa,
      grandTotalText: formatTaka(totalPaisa + deliveryChargePaisa),
      deliveryEstimate: deliveryEstimateText(String(o.created_at), zone.insideDhaka),
      createdAt: String(o.created_at),
    };
    const png = await renderInvoiceImagePng(buildInvoiceHtml(data));
    if (!png) return null;
    return { png, orderNumber: o.order_number, invoiceToken: o.invoice_token };
  } catch (err) {
    console.error('[invoice-image] render for order failed:', (err as Error).message);
    return null;
  }
}
