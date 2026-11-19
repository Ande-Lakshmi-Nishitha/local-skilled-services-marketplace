// GET /api/workers/:id/slots  -> open future slots
import { id, json } from '@/lib/api';
import { openSlots } from '@/lib/services/slots';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return json(async () => openSlots(id((await ctx.params).id)));
}
