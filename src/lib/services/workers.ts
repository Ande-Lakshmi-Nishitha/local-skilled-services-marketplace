// Workers across the three stores.
//
// Write order (there is no transaction spanning PostgreSQL and MongoDB):
//   1. PostgreSQL transaction: worker row + categories        <- source of truth
//   2. MongoDB: portfolio document (trade, skills, ...)
//   3. pgvector: 'skill' and 'bio' embeddings
// If 2 or 3 fail, the worker still exists; we retry once, log, and `npm run db:reconcile` repairs it.
import { num, numOrNull, one, pool, q, withTx, type Queryable } from '../db';
import { embedder, syncWorkerEmbeddings } from '../embeddings';
import { invalid, notFound, toAppError } from '../errors';
import { portfolios, type Certification, type PortfolioDoc } from '../mongo';

export interface WorkerInput {
  name: string; email: string; phone?: string; locality: string; bio?: string;
  hourly_rate: number; category_ids: number[]; trade: string; skills: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v: unknown, label: string, min: number, max: number): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (s.length < min || s.length > max) throw invalid(`${label} must be ${min}-${max} characters`);
  return s;
}

export function parseSkills(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : [];
  const skills = [...new Set(list.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (skills.length > 30) throw invalid('At most 30 skills');
  if (skills.some((s) => s.length > 80)) throw invalid('Each skill must be at most 80 characters');
  return skills;
}

export function parseWorkerInput(b: Record<string, unknown>): WorkerInput {
  const email = str(b.email, 'Email', 5, 120).toLowerCase();
  if (!EMAIL.test(email)) throw invalid('Email is not valid');
  const rate = Number(b.hourly_rate);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100000) throw invalid('Hourly rate must be a positive number');
  const cats = [...new Set((Array.isArray(b.category_ids) ? b.category_ids : [b.category_ids]).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!cats.length) throw invalid('Choose at least one service category');
  const bio = typeof b.bio === 'string' ? b.bio.trim() : '';
  if (bio.length > 1000) throw invalid('Bio must be at most 1000 characters');
  const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
  return {
    name: str(b.name, 'Name', 2, 80), email, phone: phone || undefined, locality: str(b.locality, 'Locality', 2, 60),
    bio: bio || undefined, hourly_rate: Math.round(rate * 100) / 100, category_ids: cats,
    trade: str(b.trade, 'Trade', 2, 60), skills: parseSkills(b.skills),
  };
}

async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch { return fn(); }
}

/** Steps 2 + 3. Returns false if something could not be synced (the worker row is kept either way). */
export async function syncDerivedStores(workerId: number, patch: { trade?: string; skills?: string[] }): Promise<boolean> {
  let ok = true;
  let doc: PortfolioDoc | null = null;
  try {
    const col = await portfolios();
    doc = await retryOnce(async () => {
      const existing = await col.findOne({ worker_id: workerId }, { projection: { _id: 0 } });
      const next: PortfolioDoc = {
        worker_id: workerId,
        trade: patch.trade ?? existing?.trade ?? 'Service provider',
        photos: existing?.photos ?? [],
        certifications: existing?.certifications ?? [],
        trade_attributes: { ...(existing?.trade_attributes ?? {}), ...(patch.skills ? { skills: patch.skills } : {}) },
        updated_at: new Date(),
      };
      await col.replaceOne({ worker_id: workerId }, next, { upsert: true });
      return next;
    });
  } catch (err) {
    ok = false;
    console.warn(`[worker ${workerId}] MongoDB sync failed, run "npm run db:reconcile":`, (err as Error).message);
  }
  try {
    await retryOnce(async () => {
      const row = await one<{ bio: string | null; categories: string[] }>(
        `SELECT w.bio, coalesce(array_agg(c.name ORDER BY c.name) FILTER (WHERE c.name IS NOT NULL), '{}') AS categories
         FROM worker w LEFT JOIN worker_category wc ON wc.worker_id = w.worker_id
         LEFT JOIN service_category c ON c.category_id = wc.category_id
         WHERE w.worker_id = $1 GROUP BY w.worker_id`, [workerId]);
      if (!row) return;
      await syncWorkerEmbeddings(pool() as unknown as Queryable, embedder(), workerId, {
        bio: row.bio, categories: row.categories,
        trade: patch.trade ?? doc?.trade ?? null, skills: patch.skills ?? doc?.trade_attributes.skills ?? [],
      });
    });
  } catch (err) {
    ok = false;
    console.warn(`[worker ${workerId}] embedding sync failed, run "npm run db:reconcile":`, (err as Error).message);
  }
  return ok;
}

async function setCategories(c: Queryable, workerId: number, ids: number[]) {
  await c.query('DELETE FROM worker_category WHERE worker_id = $1 AND NOT (category_id = ANY($2::int[]))', [workerId, ids]);
  await c.query('INSERT INTO worker_category (worker_id, category_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING', [workerId, ids]);
}

/** Self-registration. New workers are 'pending' until an admin verifies them (they are not matched until then). */
export async function registerWorker(input: WorkerInput): Promise<{ worker_id: number; synced: boolean }> {
  let workerId: number;
  try {
    workerId = await withTx(async (c) => {
      const { rows } = await c.query<{ worker_id: number }>(
        `INSERT INTO worker (name, email, phone, locality, bio, hourly_rate) VALUES ($1,$2,$3,$4,$5,$6) RETURNING worker_id`,
        [input.name, input.email, input.phone ?? null, input.locality, input.bio ?? null, input.hourly_rate]);
      await setCategories(c, rows[0].worker_id, input.category_ids);
      return rows[0].worker_id;
    });
  } catch (e) {
    throw toAppError(e);
  }
  const synced = await syncDerivedStores(workerId, { trade: input.trade, skills: input.skills });
  return { worker_id: workerId, synced };
}

export async function updateWorker(workerId: number, input: Omit<WorkerInput, 'email'>): Promise<boolean> {
  try {
    await withTx(async (c) => {
      const { rowCount } = await c.query(
        `UPDATE worker SET name = $2, phone = $3, locality = $4, bio = $5, hourly_rate = $6 WHERE worker_id = $1`,
        [workerId, input.name, input.phone ?? null, input.locality, input.bio ?? null, input.hourly_rate]);
      if (!rowCount) throw notFound('Worker not found');
      await setCategories(c, workerId, input.category_ids);
    });
  } catch (e) {
    throw toAppError(e);
  }
  return syncDerivedStores(workerId, { trade: input.trade, skills: input.skills });
}

// ----------------------------------------------------------------- reads
export interface WorkerProfile {
  worker_id: number; name: string; email: string; phone: string | null; locality: string; bio: string | null;
  hourly_rate: number; verification_status: 'pending' | 'verified' | 'rejected';
  avg_rating: number | null; rating_count: number; bayesian: number; completed_jobs: number;
  categories: { category_id: number; name: string }[];
  portfolio: PortfolioDoc | null;
  recent_ratings: { score: number; comment: string | null; created_at: Date }[];
}

export async function getWorkerProfile(workerId: number): Promise<WorkerProfile | null> {
  const w = await one<Record<string, unknown>>(
    `SELECT w.worker_id, w.name, w.email, w.phone, w.locality, w.bio, w.hourly_rate, w.verification_status,
            w.avg_rating, w.rating_count, fn_bayesian_rating(w.avg_rating, w.rating_count) AS bayesian,
            (SELECT count(*)::int FROM booking b WHERE b.worker_id = w.worker_id AND b.status = 'completed') AS completed_jobs,
            coalesce((SELECT json_agg(json_build_object('category_id', c.category_id, 'name', c.name) ORDER BY c.name)
                      FROM worker_category wc JOIN service_category c ON c.category_id = wc.category_id
                      WHERE wc.worker_id = w.worker_id), '[]'::json) AS categories
     FROM worker w WHERE w.worker_id = $1`, [workerId]);
  if (!w) return null;
  const ratings = await q<{ score: number; comment: string | null; created_at: Date }>(
    `SELECT r.score, r.comment, r.created_at FROM rating r JOIN booking b ON b.booking_id = r.booking_id
     WHERE b.worker_id = $1 ORDER BY r.created_at DESC, r.rating_id DESC LIMIT 5`, [workerId]);
  let portfolio: PortfolioDoc | null = null;
  try {
    portfolio = await (await portfolios()).findOne({ worker_id: workerId }, { projection: { _id: 0 } });
  } catch (err) {
    console.warn('[profile] MongoDB unavailable:', (err as Error).message);
  }
  return {
    worker_id: w.worker_id as number, name: w.name as string, email: w.email as string, phone: w.phone as string | null,
    locality: w.locality as string, bio: w.bio as string | null, hourly_rate: num(w.hourly_rate),
    verification_status: w.verification_status as WorkerProfile['verification_status'],
    avg_rating: numOrNull(w.avg_rating), rating_count: w.rating_count as number, bayesian: num(w.bayesian),
    completed_jobs: w.completed_jobs as number, categories: w.categories as WorkerProfile['categories'],
    portfolio, recent_ratings: ratings,
  };
}

export const listWorkerUsers = () =>
  q<{ worker_id: number; name: string; verification_status: string; categories: string }>(
    `SELECT w.worker_id, w.name, w.verification_status, string_agg(c.name, ', ' ORDER BY c.name) AS categories
     FROM worker w LEFT JOIN worker_category wc ON wc.worker_id = w.worker_id LEFT JOIN service_category c ON c.category_id = wc.category_id
     GROUP BY w.worker_id ORDER BY w.worker_id`);

// ----------------------------------------------------------------- portfolio
const SAFE_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** Parse the "extra attributes" editor: one `key: value` per line; comma-separated values become lists. */
export function parseAttributeLines(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 1) throw invalid(`"${line}" must look like key: value`);
    const key = line.slice(0, i).trim().toLowerCase().replace(/\s+/g, '_');
    if (!SAFE_KEY.test(key) || key === 'skills') throw invalid(`"${key}" is not a valid attribute name (letters, digits, underscore; not "skills")`);
    const value = line.slice(i + 1).trim();
    if (value.length > 500) throw invalid(`Value of ${key} is too long`);
    const parsePrimitive = (s: string): unknown => (s === 'true' ? true : s === 'false' ? false : /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s);
    out[key] = value.includes(',') ? value.split(',').map((s) => parsePrimitive(s.trim())).filter((s) => s !== '') : parsePrimitive(value);
  }
  if (Object.keys(out).length > 30) throw invalid('At most 30 attributes');
  return out;
}

export function attributesToLines(attrs: Record<string, unknown>): string {
  return Object.entries(attrs).filter(([k]) => k !== 'skills').map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: ${v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')}`;
    return `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`;
  }).join('\n');
}

/** "name | issuer | number | year" per line. */
export function parseCertifications(text: string): Certification[] {
  const certs = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [name, issuer, number, year] = line.split('|').map((s) => s.trim());
    if (!name) throw invalid('Each certification needs a name');
    const c: Certification = { name: name.slice(0, 120) };
    if (issuer) c.issuer = issuer.slice(0, 120);
    if (number) c.number = number.slice(0, 60);
    if (year) {
      const y = Number(year);
      if (!Number.isInteger(y) || y < 1950 || y > 2100) throw invalid(`"${year}" is not a valid year`);
      c.issued_year = y;
    }
    return c;
  });
  if (certs.length > 20) throw invalid('At most 20 certifications');
  return certs;
}

export const certificationsToLines = (c: Certification[]) =>
  c.map((x) => [x.name, x.issuer ?? '', x.number ?? '', x.issued_year ?? ''].join(' | ').replace(/( \| )+$/, '')).join('\n');

export async function savePortfolio(workerId: number, p: { trade: string; skills: string[]; attributes: Record<string, unknown>; certifications: Certification[] }): Promise<boolean> {
  const col = await portfolios();
  const existing = await col.findOne({ worker_id: workerId }, { projection: { _id: 0 } });
  await col.replaceOne({ worker_id: workerId }, {
    worker_id: workerId,
    trade: p.trade,
    photos: existing?.photos ?? [],
    certifications: p.certifications,
    trade_attributes: { ...p.attributes, skills: p.skills },
    updated_at: new Date(),
  }, { upsert: true });
  return syncDerivedStores(workerId, { trade: p.trade, skills: p.skills });   // refreshes the skill embedding
}

export async function addPhoto(workerId: number, url: string, caption?: string): Promise<void> {
  const col = await portfolios();
  const doc = await col.findOne({ worker_id: workerId });
  if (!doc) throw invalid('Save your portfolio first');
  if (doc.photos.length >= 12) throw invalid('At most 12 photos');
  await col.updateOne({ worker_id: workerId }, {
    $push: { photos: { url, ...(caption ? { caption: caption.slice(0, 200) } : {}), uploaded_at: new Date() } },
    $set: { updated_at: new Date() },
  });
}

export async function removePhoto(workerId: number, url: string): Promise<void> {
  await (await portfolios()).updateOne({ worker_id: workerId }, { $pull: { photos: { url } }, $set: { updated_at: new Date() } });
}

// ----------------------------------------------------------------- reverse matching
export async function matchingOpenRequests(workerId: number) {
  const o = { minSim: Number(process.env.MATCH_MIN_SIMILARITY ?? 0.25) };
  return q<{ request_id: number; description: string; created_at: Date; customer_locality: string | null; similarity: number }>(
    `SELECT m.request_id, r.description, r.created_at, c.locality AS customer_locality, m.similarity
     FROM fn_match_requests_for_worker($1, 10, $2) m
     JOIN service_request r ON r.request_id = m.request_id
     JOIN customer c ON c.customer_id = r.customer_id
     ORDER BY m.similarity DESC`, [workerId, o.minSim]);
}
