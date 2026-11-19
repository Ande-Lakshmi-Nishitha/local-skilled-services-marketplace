// Service requests and semantic matching (request text -> ranked, bookable workers).
import { num, numOrNull, one, q, withTx } from '../db';
import { clean, embedder, toVectorLiteral } from '../embeddings';
import { AppError, invalid, notFound } from '../errors';
import { portfolios } from '../mongo';

export interface ServiceRequest {
  request_id: number; customer_id: number; description: string;
  status: 'open' | 'booked' | 'closed' | 'cancelled'; created_at: Date;
}

export interface MatchOptions { alpha: number; minSimilarity: number; annCandidates: number }

export function matchOptions(): MatchOptions {
  const n = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    alpha: Math.min(1, Math.max(0, n(process.env.MATCH_ALPHA, 0.7))),
    minSimilarity: Math.min(1, Math.max(0, n(process.env.MATCH_MIN_SIMILARITY, 0.25))),
    annCandidates: Math.min(1000, Math.max(1, Math.round(n(process.env.MATCH_ANN_CANDIDATES, 100)))),
  };
}

/** Embed first, then insert the request and its vector in ONE transaction: never one without the other. */
export async function createRequest(customerId: number, description: string): Promise<number> {
  const text = clean(description ?? '');
  if (text.length < 5) throw invalid('Please describe the problem in at least 5 characters');
  if (text.length > 1000) throw invalid('Please keep the description under 1000 characters');

  let vec: number[];
  try {
    vec = await embedder().embed(text);
  } catch (err) {
    console.error(err);
    throw new AppError('EMBEDDING_FAILED', 'Could not analyse the request right now (embedding model unavailable). Please try again.');
  }

  return withTx(async (c) => {
    const { rows } = await c.query<{ request_id: number }>(
      'INSERT INTO service_request (customer_id, description) VALUES ($1, $2) RETURNING request_id', [customerId, text]);
    await c.query('INSERT INTO request_embedding_vector (request_id, embedding) VALUES ($1, $2::vector)',
      [rows[0].request_id, toVectorLiteral(vec)]);
    return rows[0].request_id;
  });
}

export async function getRequest(requestId: number, customerId: number): Promise<ServiceRequest> {
  const r = await one<ServiceRequest>(
    'SELECT request_id, customer_id, description, status, created_at FROM service_request WHERE request_id = $1 AND customer_id = $2',
    [requestId, customerId]);
  if (!r) throw notFound('Request not found');
  return r;
}

export const listRequests = (customerId: number) =>
  q<ServiceRequest & { booking_id: number | null }>(
    `SELECT r.request_id, r.customer_id, r.description, r.status, r.created_at,
            (SELECT b.booking_id FROM booking b WHERE b.request_id = r.request_id AND b.status <> 'cancelled'
             ORDER BY b.booking_id DESC LIMIT 1) AS booking_id
     FROM service_request r WHERE r.customer_id = $1 ORDER BY r.created_at DESC, r.request_id DESC`, [customerId]);

export async function withdrawRequest(requestId: number, customerId: number): Promise<void> {
  const rows = await q(
    `UPDATE service_request SET status = 'cancelled' WHERE request_id = $1 AND customer_id = $2 AND status = 'open' RETURNING 1`,
    [requestId, customerId]);
  if (!rows.length) throw invalid('Only open requests can be withdrawn');
}

// ----------------------------------------------------------------- matching
export interface Match {
  worker_id: number; name: string; locality: string; bio: string; hourly_rate: number;
  avg_rating: number | null; rating_count: number;
  similarity: number; trust_score: number; final_score: number;
  categories: string[];
  slots: { slot_id: number; start_time: Date; end_time: Date }[];
  portfolio: { trade: string; photo_url: string | null; skills: string[] } | null;
}

export interface MatchFilters { locality?: string | null; categoryId?: number | null; limit?: number }

/** Ensure an (older / seeded) request has its embedding. */
async function ensureRequestEmbedding(requestId: number, description: string): Promise<void> {
  const has = await one('SELECT 1 FROM request_embedding_vector WHERE request_id = $1', [requestId]);
  if (has) return;
  try {
    const vec = await embedder().embed(clean(description));
    await q('INSERT INTO request_embedding_vector (request_id, embedding) VALUES ($1, $2::vector) ON CONFLICT DO NOTHING',
      [requestId, toVectorLiteral(vec)]);
  } catch (err) {
    console.error(err);
    throw new AppError('EMBEDDING_FAILED', 'Could not analyse the request right now (embedding model unavailable).');
  }
}

export async function findMatches(requestId: number, customerId: number, f: MatchFilters = {}): Promise<Match[]> {
  const req = await getRequest(requestId, customerId);
  await ensureRequestEmbedding(requestId, req.description);
  const o = matchOptions();
  const limit = Math.min(Math.max(f.limit ?? 10, 1), 50);

  // 1. ranking happens in SQL (fn_match_workers, migration 006)
  const ranked = await q<{ worker_id: number; similarity: number; trust_score: string; final_score: number }>(
    'SELECT * FROM fn_match_workers($1::int, $2::int, $3::text, $4::int, $5::numeric, $6::numeric, $7::int)',
    [requestId, limit, f.locality || null, f.categoryId || null, o.alpha, o.minSimilarity, o.annCandidates]);
  if (!ranked.length) return [];
  const ids = ranked.map((r) => r.worker_id);

  // 2. details + categories + next 3 open slots for all matched workers: two queries, no N+1
  const details = await q<{ worker_id: number; name: string; locality: string; bio: string | null; hourly_rate: string;
                            avg_rating: string | null; rating_count: number; categories: string[] }>(
    `SELECT w.worker_id, w.name, w.locality, w.bio, w.hourly_rate, w.avg_rating, w.rating_count,
            coalesce(array_agg(c.name ORDER BY c.name) FILTER (WHERE c.name IS NOT NULL), '{}') AS categories
     FROM worker w LEFT JOIN worker_category wc ON wc.worker_id = w.worker_id
     LEFT JOIN service_category c ON c.category_id = wc.category_id
     WHERE w.worker_id = ANY($1::int[]) GROUP BY w.worker_id`, [ids]);
  const slots = await q<{ worker_id: number; slot_id: number; start_time: Date; end_time: Date }>(
    `SELECT s.worker_id, s.slot_id, s.start_time, s.end_time FROM unnest($1::int[]) AS u(worker_id)
     CROSS JOIN LATERAL (
        SELECT sl.worker_id, sl.slot_id, sl.start_time, sl.end_time FROM availability_slot sl
        WHERE sl.worker_id = u.worker_id AND sl.status = 'open' AND sl.start_time > now()
        ORDER BY sl.start_time LIMIT 3) s`, [ids]);

  // 3. portfolio previews: ONE MongoDB query. If MongoDB is down, matching still works without previews.
  const previews = new Map<number, Match['portfolio']>();
  try {
    const docs = await (await portfolios()).find({ worker_id: { $in: ids } }, { projection: { _id: 0 } }).toArray();
    for (const d of docs) {
      previews.set(d.worker_id, { trade: d.trade, photo_url: d.photos?.[0]?.url ?? null, skills: (d.trade_attributes?.skills ?? []).slice(0, 6) });
    }
  } catch (err) {
    console.warn('[matches] MongoDB unavailable, returning matches without portfolio previews:', (err as Error).message);
  }

  const byId = new Map(details.map((d) => [d.worker_id, d]));
  return ranked.flatMap((r) => {
    const d = byId.get(r.worker_id);
    if (!d) return [];
    return [{
      worker_id: d.worker_id, name: d.name, locality: d.locality, bio: d.bio ?? '', hourly_rate: num(d.hourly_rate),
      avg_rating: numOrNull(d.avg_rating), rating_count: d.rating_count,
      similarity: num(r.similarity), trust_score: num(r.trust_score), final_score: num(r.final_score),
      categories: d.categories,
      slots: slots.filter((s) => s.worker_id === d.worker_id).map(({ slot_id, start_time, end_time }) => ({ slot_id, start_time, end_time })),
      portfolio: previews.get(d.worker_id) ?? null,
    }];
  });
}

const STOP = new Set(('the and for not but are was has have had with from this that there their they you your our its into '
  + 'out off over under very much many some any all can cannot will would should could does did doing been being '
  + 'what when where which who why how need needs want wants please help someone get got keep keeps also just').split(' '));

/** Words a keyword search would use: 3+ letters, minus common stop words. */
export function keywordTerms(text: string): string[] {
  return [...new Set(clean(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

/** The baseline we compare against: plain keyword search (any word of the request appears in bio or category). */
export async function keywordBaseline(text: string): Promise<{ worker_id: number; name: string; matched: string[] }[]> {
  const words = keywordTerms(text);
  if (!words.length) return [];
  const rows = await q<{ worker_id: number; name: string; hay: string }>(
    `SELECT w.worker_id, w.name, lower(coalesce(w.bio, '') || ' ' || string_agg(c.name, ' ')) AS hay
     FROM worker w JOIN worker_category wc ON wc.worker_id = w.worker_id JOIN service_category c ON c.category_id = wc.category_id
     WHERE w.verification_status = 'verified'
     GROUP BY w.worker_id
     HAVING lower(coalesce(w.bio, '') || ' ' || string_agg(c.name, ' ')) LIKE ANY ($1::text[])
     ORDER BY w.worker_id`, [words.map((w) => `%${w}%`)]);
  return rows.map((r) => ({ worker_id: r.worker_id, name: r.name, matched: words.filter((w) => r.hay.includes(w)) }))
    .sort((a, b) => b.matched.length - a.matched.length);
}
