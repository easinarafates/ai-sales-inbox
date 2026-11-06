/** Bengali bill text for a chat order. Prices come only from the products table. */
export interface BillLine {
  name: string;
  quantity: number;
  pricePaisa: number;
}

export function formatTaka(paisa: number): string {
  return `৳${(paisa / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export function buildBillText(orderId: string, lines: BillLine[], totalPaisa: number): string {
  const items = lines
    .map((l) => `• ${l.name} × ${l.quantity} — ${formatTaka(l.pricePaisa * l.quantity)}`)
    .join('\n');
  return [
    '🧾 আপনার বিল',
    `অর্ডার: ${orderId.slice(0, 8)}`,
    items,
    `মোট: ${formatTaka(totalPaisa)}`,
    'ধন্যবাদ! অর্ডারটি কনফার্ম করতে আপনার নাম, ঠিকানা ও ফোন নম্বর দিন।',
  ].join('\n');
}
