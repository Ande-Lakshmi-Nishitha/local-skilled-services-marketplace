// POST /api/bookings { request_id, worker_id, slot_id } -> 201 booking   (customer)
// GET  /api/bookings                                     -> own bookings  (customer or worker)
import { apiRole, body, id, json } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { getSession } from '@/lib/session';
import { createBooking, getBooking, listBookings } from '@/lib/services/bookings';

export async function POST(req: Request) {
  return json(async () => {
    const s = await apiRole('customer');
    const b = await body(req);
    const bookingId = await createBooking(s.id, id(b.request_id, 'request_id'), id(b.worker_id, 'worker_id'), id(b.slot_id, 'slot_id'));
    return getBooking(bookingId, 'customer', s.id);
  }, 201);
}

export async function GET() {
  return json(async () => {
    const s = await getSession();
    if (!s || s.role === 'admin') throw new AppError('UNAUTHENTICATED', 'Sign in as a customer or worker');
    return listBookings(s.role, s.id);
  });
}
