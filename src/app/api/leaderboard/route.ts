// GET /api/leaderboard?category_id=
import { id, json } from '@/lib/api';
import { leaderboard } from '@/lib/services/admin';

export async function GET(req: Request) {
  return json(async () => {
    const c = new URL(req.url).searchParams.get('category_id');
    return leaderboard(c ? id(c, 'category_id') : null);
  });
}
