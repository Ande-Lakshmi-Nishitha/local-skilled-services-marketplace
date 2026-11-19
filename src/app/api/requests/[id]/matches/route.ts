// GET /api/requests/:id/matches?locality=&category_id=&limit=   (owner customer)
import { apiRole, id, json } from '@/lib/api';
import { findMatches } from '@/lib/services/requests';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return json(async () => {
    const s = await apiRole('customer');
    const requestId = id((await ctx.params).id);
    const u = new URL(req.url).searchParams;
    const matches = await findMatches(requestId, s.id, {
      locality: u.get('locality') || null,
      categoryId: u.get('category_id') ? id(u.get('category_id'), 'category_id') : null,
      limit: u.get('limit') ? Number(u.get('limit')) : undefined,
    });
    return { request_id: requestId, matches };
  });
}
