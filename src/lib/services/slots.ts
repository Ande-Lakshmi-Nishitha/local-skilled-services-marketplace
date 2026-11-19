// Worker availability. Overlaps are rejected by the database (exclusion constraint),
// booked slots are protected by a trigger (SLOT_NOT_EDITABLE).
import { q, withTx } from '../db';
import { invalid, notFound, toAppError } from '../errors';

export interface Slot { slot_id: number; worker_id: number; start_time: Date; end_time: Date; status: 'open' | 'reserved' | 'blocked' }

/** Open future slots of a worker (the query the partial index ix_slot_worker_open_start is built for). */
export const openSlots = (workerId: number, limit = 30) =>
  q<Slot>(`SELECT slot_id, worker_id, start_time, end_time, status FROM availability_slot
           WHERE worker_id = $1 AND status = 'open' AND start_time > now()
           ORDER BY start_time LIMIT $2`, [workerId, limit]);

/** Everything from yesterday onwards, for the worker's own calendar. */
export const workerSlots = (workerId: number) =>
  q<Slot & { booking_id: number | null; customer_name: string | null }>(
    `SELECT s.slot_id, s.worker_id, s.start_time, s.end_time, s.status, b.booking_id, c.name AS customer_name
     FROM availability_slot s
     LEFT JOIN booking b ON b.slot_id = s.slot_id AND b.status <> 'cancelled'
     LEFT JOIN service_request r ON r.request_id = b.request_id
     LEFT JOIN customer c ON c.customer_id = r.customer_id
     WHERE s.worker_id = $1 AND s.end_time > now() - interval '1 day'
     ORDER BY s.start_time`, [workerId]);

/**
 * Add slots: same start time and length on `days` consecutive days starting at `date` (India time).
 * All-or-nothing: if one overlaps an existing slot, none are added.
 */
export async function addSlots(workerId: number, date: string, time: string, hours: number, days: number): Promise<number> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid('Pick a date');
  if (!/^\d{2}:\d{2}$/.test(time)) throw invalid('Pick a start time');
  if (!(hours >= 0.5 && hours <= 8)) throw invalid('Length must be between 0.5 and 8 hours');
  if (!(Number.isInteger(days) && days >= 1 && days <= 30)) throw invalid('Repeat for 1 to 30 days');
  try {
    return await withTx(async (c) => {
      const { rows } = await c.query<{ n: number; past: number }>(
        `WITH s AS (
           SELECT (($2::date + d) + $3::time) AT TIME ZONE 'Asia/Kolkata' AS st FROM generate_series(0, $5::int - 1) d
         ), ins AS (
           INSERT INTO availability_slot (worker_id, start_time, end_time)
           SELECT $1, st, st + make_interval(mins => ($4::numeric * 60)::int) FROM s WHERE st > now()
           RETURNING 1
         )
         SELECT (SELECT count(*)::int FROM ins) AS n, (SELECT count(*)::int FROM s WHERE st <= now()) AS past`,
        [workerId, date, time, hours, days]);
      if (rows[0].n === 0) throw invalid('All of those times are in the past');
      return rows[0].n;
    });
  } catch (e) {
    throw toAppError(e);
  }
}

export async function setSlotStatus(workerId: number, slotId: number, status: 'open' | 'blocked'): Promise<void> {
  try {
    const rows = await q('UPDATE availability_slot SET status = $3 WHERE slot_id = $1 AND worker_id = $2 RETURNING 1', [slotId, workerId, status]);
    if (!rows.length) throw notFound('Slot not found');
  } catch (e) {
    throw toAppError(e);
  }
}

export async function deleteSlot(workerId: number, slotId: number): Promise<void> {
  try {
    const rows = await q('DELETE FROM availability_slot WHERE slot_id = $1 AND worker_id = $2 RETURNING 1', [slotId, workerId]);
    if (!rows.length) throw notFound('Slot not found');
  } catch (e) {
    const err = toAppError(e);
    if (err.message.startsWith('Something this refers to')) throw invalid('This slot has booking history and cannot be deleted; block it instead');
    throw err;
  }
}
