/**
 * Order delivery contact — the A-to-Z "who ordered" details.
 *
 * An order is only real when the shop knows WHO to deliver to: the
 * customer's name, phone number and delivery address. Before migration 24
 * the create_order tool accepted only {items}, so the AI could not pass or
 * store the contact even when it asked for it — and once falsely claimed it
 * already had the phone/address and created the order anyway.
 *
 * This module is the single rule both order-creation paths share:
 *  - the AI create_order tool (ai-agent/tools.ts)
 *  - POST /api/orders (orders/routes.ts)
 *
 * resolveOrderContact() takes what the caller was given (or nothing) plus
 * what the customer row already stores, and:
 *  - refuses (returns an error) when the phone or the delivery address is
 *    still missing — the caller must ask the customer for it first, never
 *    create the order and never claim the contact is already known;
 *  - otherwise stores the given contact on the customer row (name only when
 *    the owner has NOT corrected it by hand — name_manually_set — the
 *    owner's correction is final) and returns the snapshot the order row
 *    must carry (orders.customer_name / customer_phone / delivery_address).
 *
 * Nothing here invents data: a missing phone/address stays missing and is
 * reported as missing; the UI shows 'দেওয়া হয়নি' / 'Not provided' for it.
 */

export interface ContactDb {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface OrderContactInput {
  customerName?: unknown;
  customerPhone?: unknown;
  deliveryAddress?: unknown;
  /** Aliases the AI model sometimes uses. */
  name?: unknown;
  phone?: unknown;
  address?: unknown;
}

export interface OrderContact {
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  missingPhone: boolean;
  missingAddress: boolean;
}

function asNonEmpty(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, maxLen);
}

export async function resolveOrderContact(
  db: ContactDb,
  workspaceId: string,
  customerId: string,
  input: OrderContactInput,
): Promise<{ contact: OrderContact | null; error?: string; missingPhone?: boolean; missingAddress?: boolean }> {
  const { rows } = await db.query<{
    id: string;
    name: string | null;
    phone: string | null;
    address: string | null;
    name_manually_set: boolean | null;
  }>(
    'SELECT id, name, phone, address, name_manually_set FROM customers WHERE workspace_id = $1 AND id = $2',
    [workspaceId, customerId],
  );
  if (rows.length === 0) return { contact: null, error: 'Customer not found' };
  const stored = rows[0];

  const givenName = asNonEmpty(input.customerName ?? input.name, 200);
  const givenPhone = asNonEmpty(input.customerPhone ?? input.phone, 30);
  const givenAddress = asNonEmpty(input.deliveryAddress ?? input.address, 500);

  const phone = givenPhone ?? (stored.phone ? stored.phone.trim() : null) ?? null;
  const address = givenAddress ?? (stored.address ? stored.address.trim() : null) ?? null;
  const name = givenName ?? stored.name ?? null;

  const missingPhone = !phone;
  const missingAddress = !address;
  if (missingPhone || missingAddress) {
    const missing = [
      missingPhone ? 'phone number (ফোন নম্বর)' : '',
      missingAddress ? 'delivery address (ঠিকানা)' : '',
    ]
      .filter(Boolean)
      .join(' and ');
    return {
      contact: null,
      error: `Cannot create the order yet — the customer's ${missing} is missing. Ask the customer for it first, do not guess it and do not say you already have it.`,
      missingPhone,
      missingAddress,
    };
  }

  // Store what the customer just gave on their row, so the next order and
  // the Inbox already know it. Name: never overwrite the owner's hand
  // correction (name_manually_set) — the owner's correction is final.
  if (givenPhone || givenAddress || (givenName && !stored.name_manually_set)) {
    await db.query(
      `UPDATE customers SET
         phone = COALESCE($2, phone),
         address = COALESCE($3, address),
         name = CASE WHEN $4::boolean THEN name ELSE COALESCE($5, name) END,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $6`,
      [workspaceId, givenPhone, givenAddress, stored.name_manually_set === true, givenName, customerId],
    );
  }

  return {
    contact: {
      customerName: name,
      customerPhone: phone,
      deliveryAddress: address,
      missingPhone: false,
      missingAddress: false,
    },
  };
}
