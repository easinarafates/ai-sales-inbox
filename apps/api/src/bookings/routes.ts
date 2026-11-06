/**
 * Receptionist mode (Phase 3, PDF §4 ঞ) — bookings for service businesses.
 * Full paths, mounted at /api.
 *
 * A booking stores the service, date/time and optional advance-payment
 * transaction id/amount (advance_paisa — the amount is recorded as given;
 * no payment is verified here). The day before a confirmed booking, the
 * booking appears in reminders-due; POST /:id/remind marks reminder_sent
 * and saves an outbound reminder message row (real Meta send is still a
 * stub — see the log line there).
 */
import { Router, type Response } from 'express';
import { query, queryOne } from '../db/pool';
import type { AuthRequest } from '../types';
import { getWorkspaceId, requireAuth } from '../auth/auth';

export const bookingsRouter = Router();
bookingsRouter.use(requireAuth);

interface BookingRow {
  id: string;
  customer_id: string;
  service: string;
  date: string;
  time: string;
  advance_tx_id: string | null;
  advance_paisa: number | null;
  status: string;
  reminder_sent: boolean;
  notes: string | null;
  created_at: string;
}

const BOOKING_COLUMNS =
  'id, customer_id, service, date, time, advance_tx_id, advance_paisa, status, reminder_sent, notes, created_at';

/** GET /api/bookings?date=&status= */
bookingsRouter.get('/bookings', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const date = typeof req.query.date === 'string' ? req.query.date : null;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const params: unknown[] = [workspaceId];
  let where = 'WHERE workspace_id = $1';
  if (date) {
    params.push(date);
    where += ` AND date = $${params.length}`;
  }
  if (status) {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const { rows } = await query<BookingRow>(
    workspaceId,
    `SELECT ${BOOKING_COLUMNS} FROM bookings ${where} ORDER BY date ASC, time ASC LIMIT 200`,
    params,
  );
  res.json({ bookings: rows });
});

/** GET /api/bookings/reminders-due — tomorrow's confirmed bookings, not yet reminded. */
bookingsRouter.get('/bookings/reminders-due', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { rows } = await query<BookingRow>(
    workspaceId,
    `SELECT ${BOOKING_COLUMNS} FROM bookings
     WHERE workspace_id = $1 AND date = $2 AND status = 'confirmed' AND reminder_sent = FALSE
     ORDER BY time ASC`,
    [workspaceId, tomorrow],
  );
  res.json({ bookings: rows });
});

/** POST /api/bookings {customerId, service, date, time, advanceTxId?, advancePaisa?, notes?} */
bookingsRouter.post('/bookings', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { customerId, service, date, time, advanceTxId, advancePaisa, notes } = (req.body ?? {}) as {
    customerId?: string;
    service?: string;
    date?: string;
    time?: string;
    advanceTxId?: string;
    advancePaisa?: number;
    notes?: string;
  };
  if (!customerId || !service || !service.trim() || !date || !time || !time.trim()) {
    res.status(400).json({ error: 'customerId, service, date and time are required' });
    return;
  }
  const customer = await queryOne<{ id: string }>(
    workspaceId,
    'SELECT id FROM customers WHERE workspace_id = $1 AND id = $2',
    [workspaceId, customerId],
  );
  if (!customer) {
    res.status(400).json({ error: 'Customer not found in this workspace' });
    return;
  }
  const { rows } = await query<BookingRow>(
    workspaceId,
    `INSERT INTO bookings (workspace_id, customer_id, service, date, time, advance_tx_id, advance_paisa, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed')
     RETURNING ${BOOKING_COLUMNS}`,
    [workspaceId, customerId, service.trim(), date, time.trim(), advanceTxId ?? null, advancePaisa ?? null, notes ?? null],
  );
  res.status(201).json({ booking: rows[0] });
});

/** PATCH /api/bookings/:id {status?, advanceTxId?, advancePaisa?} */
bookingsRouter.patch('/bookings/:id', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const { status, advanceTxId, advancePaisa } = (req.body ?? {}) as {
    status?: string;
    advanceTxId?: string;
    advancePaisa?: number;
  };
  if (status && !['confirmed', 'cancelled', 'completed'].includes(status)) {
    res.status(400).json({ error: 'status must be confirmed, cancelled or completed' });
    return;
  }
  const { rows } = await query<BookingRow>(
    workspaceId,
    `UPDATE bookings
     SET status = COALESCE($1, status), advance_tx_id = COALESCE($2, advance_tx_id),
         advance_paisa = COALESCE($3, advance_paisa), updated_at = now()
     WHERE workspace_id = $4 AND id = $5 RETURNING ${BOOKING_COLUMNS}`,
    [status ?? null, advanceTxId ?? null, advancePaisa ?? null, workspaceId, req.params.id],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }
  res.json({ booking: rows[0] });
});

/**
 * POST /api/bookings/:id/remind — marks reminder_sent and saves an outbound
 * reminder message row on the customer's latest conversation (if one exists).
 * STUB: the message row is saved + logged only; real Meta sending needs
 * Meta approval. Already-reminded bookings are returned unchanged.
 */
bookingsRouter.post('/bookings/:id/remind', async (req: AuthRequest, res: Response) => {
  const workspaceId = getWorkspaceId(req);
  const booking = await queryOne<BookingRow>(
    workspaceId,
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, req.params.id],
  );
  if (!booking) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }
  if (booking.reminder_sent) {
    res.json({ booking, alreadySent: true });
    return;
  }
  const conversation = await queryOne<{ id: string }>(
    workspaceId,
    `SELECT id FROM conversations WHERE workspace_id = $1 AND customer_id = $2
     ORDER BY updated_at DESC LIMIT 1`,
    [workspaceId, booking.customer_id],
  );
  const reminderText = `আগামীকাল ${booking.date} ${booking.time}-এ আপনার ${booking.service} বুকিং আছে। দেখা হবে!`;
  if (conversation) {
    await query(
      workspaceId,
      `INSERT INTO messages (workspace_id, conversation_id, direction, type, body)
       VALUES ($1, $2, 'out', 'text', $3)`,
      [workspaceId, conversation.id, reminderText],
    );
  }
  console.log(
    `[booking-reminder-stub] booking ${booking.id} reminder saved${conversation ? '' : ' (no conversation — no message row)'} (STUB — not really sent; real Meta send needs approval)`,
  );
  const { rows } = await query<BookingRow>(
    workspaceId,
    `UPDATE bookings SET reminder_sent = TRUE, updated_at = now()
     WHERE workspace_id = $1 AND id = $2 RETURNING ${BOOKING_COLUMNS}`,
    [workspaceId, req.params.id],
  );
  res.json({ booking: rows[0] });
});
