// GET /api/bookings/:id   (a party to the booking, or an admin)
import { id, json } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { getSession } from '@/lib/session';
import { getBooking } from '@/lib/services/bookings';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return json(async () => {
    const s = await getSession();
    if (!s) throw new AppError('UNAUTHENTICATED', 'Sign in first');
    return getBooking(id((await ctx.params).id), s.role, s.id);
  });
}
