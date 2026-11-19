// GET /api/workers/:id  -> public profile (PostgreSQL + MongoDB portfolio + recent ratings)
import { id, json } from '@/lib/api';
import { notFound } from '@/lib/errors';
import { getWorkerProfile } from '@/lib/services/workers';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return json(async () => {
    const w = await getWorkerProfile(id((await ctx.params).id));
    if (!w || w.verification_status !== 'verified') throw notFound('Worker not found');
    const { email: _e, phone: _p, ...pub } = w;
    return pub;
  });
}
