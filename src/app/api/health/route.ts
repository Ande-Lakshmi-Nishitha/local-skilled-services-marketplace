// GET /api/health - are both databases reachable?
import { one } from '@/lib/db';
import { mongoDb } from '@/lib/mongo';

export async function GET() {
  const out: Record<string, string> = {};
  try { await one('SELECT 1'); out.postgres = 'ok'; } catch (e) { out.postgres = (e as Error).message; }
  try { await (await mongoDb()).command({ ping: 1 }); out.mongodb = 'ok'; } catch (e) { out.mongodb = (e as Error).message; }
  return Response.json(out, { status: out.postgres === 'ok' && out.mongodb === 'ok' ? 200 : 503 });
}
