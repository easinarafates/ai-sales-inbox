/** Bengali bill text for a chat order. Prices come only from the products table. */
export interface BillLine {
  name: string;
  quantity: number;
  pricePaisa: number;
}

export function formatTaka(paisa: number): string {
  return `৳${(paisa / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export interface BillContact {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
}

export function buildBillText(orderId: string, lines: BillLine[], totalPaisa: number, contact?: BillContact): string {
  const items = lines
    .map((l) => `• ${l.name} × ${l.quantity} — ${formatTaka(l.pricePaisa * l.quantity)}`)
    .join('\n');
  // An order is only created once the delivery contact is known (the
  // create_order tool and POST /api/orders refuse without it), so the bill
  // confirms the delivery details back to the customer. The old last line
  // ("give your name, address and phone to confirm") is kept only as a
  // fallback for orders that somehow have no contact — it must never be
  // shown for an order that already has one.
  const deliveryLines: string[] = [];
  if (contact?.name) deliveryLines.push(`ডেলিভারি: ${contact.name}`);
  if (contact?.phone) deliveryLines.push(`ফোন: ${contact.phone}`);
  if (contact?.address) deliveryLines.push(`ঠিকানা: ${contact.address}`);
  const delivery =
    deliveryLines.length > 0
      ? deliveryLines.join('\n')
      : 'ধন্যবাদ! অর্ডারটি কনফার্ম করতে আপনার নাম, ঠিকানা ও ফোন নম্বর দিন।';
  return [
    '🧾 আপনার বিল',
    `অর্ডার: ${orderId.slice(0, 8)}`,
    items,
    `মোট: ${formatTaka(totalPaisa)}`,
    delivery,
  ].join('\n');
}
