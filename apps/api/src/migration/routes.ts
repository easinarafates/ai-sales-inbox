/**
 * Data migration (Phase 3, PDF §4 ঞ) — import customers/products/orders
 * from CSV text, e.g. exported from another system.
 * Full paths, mounted at /api.
 *
 * Hand-rolled CSV parser (no new dependencies): quoted fields, "" escapes,
 * commas/newlines inside quotes, CRLF, and a header row. Prices always come
 * from the products table (orders import) — never from the CSV.
 * Every row is validated; bad rows are reported in errors[] and do not stop
 * the rest. Each import is recorded in migration_imports.
 */
import { Router, type Response } from 'express';
import { query } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const migrationRouter = Router();
migrationRouter.use(requireAuth);

type ImportType = 'customers' | 'products' | 'orders';

interface RowError {
  row: number;
  error: string;
}

/**
 * Parse CSV text into rows of fields. Handles: "quoted, fields", "" escapes,
 * commas and newlines inside quotes, CRLF line endings, trailing empty line.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  const pushField = (): void => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const pushRow = (): void => {
    pushField();
    // Skip a fully-empty trailing row (e.g. final newline).
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      // A quote only opens a quoted field at the start of a field.
      if (field === '' && !fieldStarted) inQuotes = true;
      else field += ch;
      fieldStarted = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      // CRLF: skip the \r, the \n ends the row.
      continue;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (field !== '' || fieldStarted || row.length > 0) pushRow();
  return rows;
}

const REQUIRED_COLUMNS: Record<ImportType, string[]> = {
  customers: ['name', 'phone', 'address'],
  products: ['name', 'price_paisa', 'size', 'stock', 'description'],
  orders: ['customer_phone', 'product_name', 'quantity'],
};

function headerIndex(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((h, i) => {
    map[h.trim().toLowerCase()] = i;
  });
  return map;
}

function cell(row: string[], idx: Record<string, number>, col: string): string {
  const i = idx[col];
  if (i === undefined) return '';
  return (row[i] ?? '').trim();
}

function parseNonNegativeInt(raw: string, col: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${col} সংখ্যা হতে হবে`);
  return Number(raw);
}

/** POST /api/migration/import {type, csv} → {imported, failed, errors, importId} */
migrationRouter.post('/migration/import', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { type, csv } = (req.body ?? {}) as { type?: string; csv?: string };
  if (type !== 'customers' && type !== 'products' && type !== 'orders') {
    res.status(400).json({ error: "type must be 'customers', 'products' or 'orders'" });
    return;
  }
  if (typeof csv !== 'string' || !csv.trim()) {
    res.status(400).json({ error: 'csv text is required' });
    return;
  }
  const importType = type as ImportType;
  const allRows = parseCsv(csv);
  if (allRows.length < 2) {
    res.status(400).json({ error: 'CSV-এ হেডার + কমপক্ষে ১টি ডাটা লাইন লাগবে' });
    return;
  }
  const idx = headerIndex(allRows[0] as string[]);
  const missing = REQUIRED_COLUMNS[importType].filter((c) => idx[c] === undefined);
  if (missing.length > 0) {
    res.status(400).json({ error: `CSV হেডারে এই কলামগুলো নেই: ${missing.join(', ')}` });
    return;
  }

  const errors: RowError[] = [];
  let imported = 0;
  const dataRows = allRows.slice(1);
  for (let n = 0; n < dataRows.length; n++) {
    const row = dataRows[n] as string[];
    const rowNo = n + 2; // header is row 1
    if (row.every((c) => c.trim() === '')) continue; // skip blank lines
    try {
      if (importType === 'customers') {
        const name = cell(row, idx, 'name');
        const phone = cell(row, idx, 'phone');
        const address = cell(row, idx, 'address');
        if (!name) throw new Error('name খালি');
        if (!phone) throw new Error('phone খালি');
        await query(
          workspaceId,
          'INSERT INTO customers (workspace_id, name, phone, address) VALUES ($1, $2, $3, $4)',
          [workspaceId, name, phone, address || null],
        );
      } else if (importType === 'products') {
        const name = cell(row, idx, 'name');
        const pricePaisa = parseNonNegativeInt(cell(row, idx, 'price_paisa'), 'price_paisa');
        const size = cell(row, idx, 'size');
        const stockRaw = cell(row, idx, 'stock');
        const stock = stockRaw === '' ? 0 : parseNonNegativeInt(stockRaw, 'stock');
        const description = cell(row, idx, 'description');
        if (!name) throw new Error('name খালি');
        await query(
          workspaceId,
          'INSERT INTO products (workspace_id, name, price_paisa, size, stock, description) VALUES ($1, $2, $3, $4, $5, $6)',
          [workspaceId, name, pricePaisa, size || null, stock, description || null],
        );
      } else {
        // orders — price comes ONLY from the products table, never the CSV.
        const customerPhone = cell(row, idx, 'customer_phone');
        const productName = cell(row, idx, 'product_name');
        const quantity = parseNonNegativeInt(cell(row, idx, 'quantity'), 'quantity');
        if (quantity < 1) throw new Error('quantity কমপক্ষে ১ হতে হবে');
        if (!customerPhone) throw new Error('customer_phone খালি');
        if (!productName) throw new Error('product_name খালি');
        const { rows: customers } = await query<{ id: string }>(
          workspaceId,
          'SELECT id FROM customers WHERE workspace_id = $1 AND phone = $2 LIMIT 1',
          [workspaceId, customerPhone],
        );
        if (customers.length === 0) throw new Error(`এই ফোনের কাস্টমার নেই: ${customerPhone}`);
        const { rows: products } = await query<{ id: string; price_paisa: number }>(
          workspaceId,
          'SELECT id, price_paisa FROM products WHERE workspace_id = $1 AND name ILIKE $2 LIMIT 1',
          [workspaceId, productName],
        );
        if (products.length === 0) throw new Error(`এই নামের প্রোডাক্ট নেই: ${productName}`);
        const product = products[0] as { id: string; price_paisa: number };
        const totalPaisa = Number(product.price_paisa) * quantity;
        const { rows: orderRows } = await query<{ id: string }>(
          workspaceId,
          `INSERT INTO orders (workspace_id, customer_id, source, status, payment_status, total_paisa)
           VALUES ($1, $2, 'team', 'pending', 'unpaid', $3) RETURNING id`,
          [workspaceId, (customers[0] as { id: string }).id, totalPaisa],
        );
        await query(
          workspaceId,
          'INSERT INTO order_items (workspace_id, order_id, product_id, quantity, price_paisa) VALUES ($1, $2, $3, $4, $5)',
          [workspaceId, (orderRows[0] as { id: string }).id, product.id, quantity, Number(product.price_paisa)],
        );
      }
      imported++;
    } catch (err) {
      errors.push({ row: rowNo, error: err instanceof Error ? err.message : 'অজানা ত্রুটি' });
    }
  }

  const totalRows = dataRows.filter((r) => !r.every((c) => c.trim() === '')).length;
  const { rows: importRows } = await query<{ id: string }>(
    workspaceId,
    `INSERT INTO migration_imports (workspace_id, type, total_rows, imported_rows, failed_rows, errors)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [workspaceId, importType, totalRows, imported, errors.length, JSON.stringify(errors)],
  );
  res.json({
    imported,
    failed: errors.length,
    errors,
    importId: (importRows[0] as { id: string }).id,
  });
});

/** GET /api/migration/imports — past imports, newest first. */
migrationRouter.get('/migration/imports', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { rows } = await query(
    workspaceId,
    'SELECT id, type, total_rows, imported_rows, failed_rows, errors, created_at FROM migration_imports WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200',
    [workspaceId],
  );
  res.json({ imports: rows });
});
