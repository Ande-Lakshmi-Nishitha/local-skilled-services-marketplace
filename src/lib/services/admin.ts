// Admin moderation and analytics (reads come from the views in migration 005).
import { num, pool, q } from '../db';
import { invalid, toAppError } from '../errors';
import { portfolios, type PortfolioDoc } from '../mongo';

export async function pendingWorkers() {
  const rows = await q<{ worker_id: number; name: string; email: string; locality: string; bio: string | null;
                         hourly_rate: string; created_at: Date; categories: string }>(
    `SELECT w.worker_id, w.name, w.email, w.locality, w.bio, w.hourly_rate, w.created_at,
            string_agg(c.name, ', ' ORDER BY c.name) AS categories
     FROM worker w LEFT JOIN worker_category wc ON wc.worker_id = w.worker_id
     LEFT JOIN service_category c ON c.category_id = wc.category_id
     WHERE w.verification_status = 'pending' GROUP BY w.worker_id ORDER BY w.created_at`);
  let docs: PortfolioDoc[] = [];
  try {
    docs = await (await portfolios()).find({ worker_id: { $in: rows.map((r) => r.worker_id) } }, { projection: { _id: 0 } }).toArray();
  } catch { /* MongoDB down: show without portfolio */ }
  const byId = new Map(docs.map((d) => [d.worker_id, d]));
  return rows.map((r) => ({ ...r, hourly_rate: num(r.hourly_rate), portfolio: byId.get(r.worker_id) ?? null }));
}

export async function reviewWorker(workerId: number, adminId: number, decision: string): Promise<void> {
  if (decision !== 'verified' && decision !== 'rejected') throw invalid('Unknown decision');
  try {
    await pool().query('CALL sp_review_worker($1, $2, $3)', [workerId, adminId, decision]);
  } catch (e) {
    throw toAppError(e);
  }
}

export const listDisputes = () =>
  q<{ dispute_id: number; booking_id: number; raised_by_role: string; reason: string; status: string;
      resolution_note: string | null; created_at: Date; customer_name: string; worker_name: string;
      paid: string; refunded: string; booking_status: string }>(
    `SELECT d.dispute_id, d.booking_id, d.raised_by_role, d.reason, d.status, d.resolution_note, d.created_at,
            c.name AS customer_name, w.name AS worker_name, b.status AS booking_status,
            coalesce((SELECT sum(p.amount) FROM payment p WHERE p.invoice_id = i.invoice_id AND p.status <> 'failed'), 0) AS paid,
            coalesce((SELECT sum(p.refund_amount) FROM payment p WHERE p.invoice_id = i.invoice_id), 0) AS refunded
     FROM dispute d
     JOIN booking b ON b.booking_id = d.booking_id
     JOIN service_request r ON r.request_id = b.request_id
     JOIN customer c ON c.customer_id = r.customer_id
     JOIN worker w ON w.worker_id = b.worker_id
     LEFT JOIN invoice i ON i.booking_id = b.booking_id
     ORDER BY (d.status = 'open') DESC, d.created_at DESC LIMIT 50`);

export async function resolveDispute(disputeId: number, adminId: number, status: string, note: string, refund: number): Promise<void> {
  if (!Number.isFinite(refund) || refund < 0) throw invalid('Refund must be 0 or more');
  try {
    await pool().query('CALL sp_resolve_dispute($1, $2, $3, $4, $5)', [disputeId, adminId, status, note, refund]);
  } catch (e) {
    throw toAppError(e);
  }
}

export async function analytics() {
  const [kpis] = await q<Record<string, string | number | null>>('SELECT * FROM v_platform_kpis');
  const categories = await q<{ category_name: string; bookings: number; completed: number; net_revenue: string }>(
    'SELECT category_name, bookings::int, completed::int, net_revenue FROM v_category_stats ORDER BY net_revenue DESC');
  const days = await q<{ day: Date; net_revenue: string; payments: number }>(
    'SELECT day, net_revenue, payments::int FROM v_revenue_by_day ORDER BY day');
  return { kpis, categories, days };
}

export const leaderboard = (categoryId?: number | null) =>
  q<{ category_id: number; category_name: string; worker_id: number; name: string; locality: string;
      avg_rating: string | null; rating_count: number; bayesian_score: string; completed_jobs: number; rank_in_category: number }>(
    `SELECT * FROM v_worker_leaderboard WHERE ($1::int IS NULL OR category_id = $1) AND rank_in_category <= 10
     ORDER BY category_name, rank_in_category, worker_id`, [categoryId ?? null]);
