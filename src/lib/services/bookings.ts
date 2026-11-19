// Bookings, invoices, payments, ratings, disputes. Every state change is ONE stored-procedure call,
// so the business rules (and their atomicity) live in the database - see migration 004.
import { num, one, pool, q } from '../db';
import { invalid, notFound, toAppError } from '../errors';
import type { Role } from '../session';

async function call<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T> {
  try {
    const res = await pool().query<T>(sql, params);
    return res.rows[0] ?? ({} as T);
  } catch (e) {
    throw toAppError(e);
  }
}

export async function createBooking(customerId: number, requestId: number, workerId: number, slotId: number): Promise<number> {
  const r = await call<{ p_booking_id: number }>('CALL sp_create_booking($1, $2, $3, $4, NULL, NULL)', [customerId, requestId, workerId, slotId]);
  return r.p_booking_id;
}

export async function cancelBooking(bookingId: number, role: Role, actorId: number): Promise<{ refund: number; policy: string }> {
  const r = await call<{ p_refund_amount: string; p_policy: string }>('CALL sp_cancel_booking($1, $2, $3, NULL, NULL)', [bookingId, role, actorId]);
  return { refund: num(r.p_refund_amount), policy: r.p_policy };
}

export async function payInvoice(invoiceId: number, customerId: number, method: string): Promise<number> {
  if (!['upi', 'card', 'netbanking', 'cash'].includes(method)) throw invalid('Choose a payment method');
  const r = await call<{ p_payment_id: number }>('CALL sp_pay_invoice($1, $2, $3, NULL)', [invoiceId, customerId, method]);
  return r.p_payment_id;
}

export async function setOutcome(bookingId: number, workerId: number, outcome: 'completed' | 'no_show'): Promise<void> {
  await call('CALL sp_set_booking_outcome($1, $2, $3)', [bookingId, workerId, outcome]);
}

export async function rateBooking(bookingId: number, customerId: number, score: number, comment: string): Promise<void> {
  if (!Number.isInteger(score) || score < 1 || score > 5) throw invalid('Choose 1 to 5 stars');
  await call('CALL sp_rate_booking($1, $2, $3, $4, NULL)', [bookingId, customerId, score, comment.slice(0, 1000)]);
}

export async function raiseDispute(bookingId: number, role: 'customer' | 'worker', actorId: number, reason: string): Promise<void> {
  const r = reason.trim();
  if (r.length < 5 || r.length > 1000) throw invalid('Describe the problem in 5-1000 characters');
  await call('CALL sp_raise_dispute($1, $2, $3, $4, NULL)', [bookingId, role, actorId, r]);
}

// ----------------------------------------------------------------- reads
export interface BookingRow {
  booking_id: number; status: string; created_at: Date; cancelled_at: Date | null; cancelled_by: string | null;
  request_id: number; description: string; customer_id: number; customer_name: string; customer_phone: string | null;
  worker_id: number; worker_name: string; worker_phone: string | null;
  slot_id: number; start_time: Date; end_time: Date;
  invoice_id: number | null; amount: number | null; invoice_status: string | null;
  paid: number; refunded: number; rating_score: number | null; rating_comment: string | null;
  open_disputes: number;
}

const BOOKING_SELECT = `
  SELECT b.booking_id, b.status, b.created_at, b.cancelled_at, b.cancelled_by,
         r.request_id, r.description, c.customer_id, c.name AS customer_name, c.phone AS customer_phone,
         w.worker_id, w.name AS worker_name, w.phone AS worker_phone,
         s.slot_id, s.start_time, s.end_time,
         i.invoice_id, i.amount, i.status AS invoice_status,
         coalesce((SELECT sum(p.amount) FROM payment p WHERE p.invoice_id = i.invoice_id AND p.status <> 'failed'), 0) AS paid,
         coalesce((SELECT sum(p.refund_amount) FROM payment p WHERE p.invoice_id = i.invoice_id), 0) AS refunded,
         rt.score AS rating_score, rt.comment AS rating_comment,
         (SELECT count(*)::int FROM dispute d WHERE d.booking_id = b.booking_id AND d.status = 'open') AS open_disputes
  FROM booking b
  JOIN service_request r ON r.request_id = b.request_id
  JOIN customer c        ON c.customer_id = r.customer_id
  JOIN worker w          ON w.worker_id = b.worker_id
  JOIN availability_slot s ON s.slot_id = b.slot_id
  LEFT JOIN invoice i    ON i.booking_id = b.booking_id
  LEFT JOIN rating rt    ON rt.booking_id = b.booking_id`;

const fix = (r: Record<string, unknown>): BookingRow => ({
  ...(r as unknown as BookingRow),
  amount: r.amount === null ? null : num(r.amount), paid: num(r.paid), refunded: num(r.refunded),
});

export async function listBookings(role: 'customer' | 'worker', id: number): Promise<BookingRow[]> {
  const where = role === 'customer' ? 'c.customer_id = $1' : 'w.worker_id = $1';
  const rows = await q(`${BOOKING_SELECT} WHERE ${where}
    ORDER BY (b.status = 'confirmed') DESC, s.start_time DESC LIMIT 100`, [id]);
  return rows.map(fix);
}

/** One booking, only for someone who is a party to it (or an admin). */
export async function getBooking(bookingId: number, role: Role, id: number): Promise<BookingRow> {
  const r = await one(`${BOOKING_SELECT} WHERE b.booking_id = $1`, [bookingId]);
  if (!r) throw notFound('Booking not found');
  const b = fix(r);
  if ((role === 'customer' && b.customer_id !== id) || (role === 'worker' && b.worker_id !== id)) throw notFound('Booking not found');
  return b;
}

export const bookingDisputes = (bookingId: number) =>
  q<{ dispute_id: number; raised_by_role: string; reason: string; status: string; resolution_note: string | null; created_at: Date }>(
    'SELECT dispute_id, raised_by_role, reason, status, resolution_note, created_at FROM dispute WHERE booking_id = $1 ORDER BY dispute_id', [bookingId]);

export const bookingPayments = (invoiceId: number) =>
  q<{ payment_id: number; amount: string; method: string; status: string; refund_amount: string; paid_at: Date | null }>(
    'SELECT payment_id, amount, method, status, refund_amount, paid_at FROM payment WHERE invoice_id = $1 ORDER BY payment_id', [invoiceId]);

/** What a cancellation right now would refund (same rule as sp_cancel_booking), for the confirmation text. */
export function refundPreview(b: BookingRow, role: Role): { pct: number; label: string } {
  const hours = (new Date(b.start_time).getTime() - Date.now()) / 3_600_000;
  if (role !== 'customer' || hours >= 24) return { pct: 100, label: 'full refund' };
  if (hours >= 2) return { pct: 50, label: '50% refund (less than 24 h before the start)' };
  return { pct: 0, label: 'no refund (less than 2 h before the start)' };
}
