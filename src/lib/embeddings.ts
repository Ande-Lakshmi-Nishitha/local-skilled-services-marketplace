// Text -> 384-dim vector. Callers only use embed()/embedBatch(); which model runs is configuration.
//
//   EMBEDDING_PROVIDER=transformers (default)  all-MiniLM-L6-v2 run locally with @huggingface/transformers.
//                                               First use downloads ~90 MB into EMBEDDING_CACHE_DIR.
//   EMBEDDING_PROVIDER=hash                     Offline fallback: hashed bag of words. NOT semantic - only
//                                               for networks where the model download is blocked.
import type { Queryable } from './db';

export interface Embedder {
  readonly name: string;
  readonly dim: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 384);

// ------------------------------------------------------------------ providers
type Extractor = (input: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

function transformersEmbedder(): Embedder {
  const model = process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
  const dtype = process.env.EMBEDDING_DTYPE || 'fp32';
  let loading: Promise<Extractor> | null = null;

  const load = () => {
    if (!loading) {
      loading = (async () => {
        const t = await import('@huggingface/transformers');
        t.env.cacheDir = process.env.EMBEDDING_CACHE_DIR || '.hf-cache';
        if (process.env.EMBEDDING_LOCAL_DIR) {            // pre-downloaded model folder, no network
          t.env.localModelPath = process.env.EMBEDDING_LOCAL_DIR;
          t.env.allowRemoteModels = false;
        }
        if (process.env.HF_REMOTE_HOST) t.env.remoteHost = process.env.HF_REMOTE_HOST;   // e.g. a mirror
        const make = t.pipeline as unknown as (task: string, model: string, o: object) => Promise<Extractor>;
        return make('feature-extraction', model, { dtype });
      })().catch((err) => {
        loading = null;
        throw new Error(`Could not load the embedding model "${model}". Check your internet connection, or see README "Embedding model". Cause: ${(err as Error).message}`);
      });
    }
    return loading;
  };

  const run = async (texts: string[]) => {
    const extractor = await load();
    const out = (await extractor(texts.map((s) => s.slice(0, 2000)), { pooling: 'mean', normalize: true })).tolist();
    for (const v of out) {
      if (v.length !== EMBEDDING_DIM) throw new Error(`Model returned ${v.length} dims but EMBEDDING_DIM is ${EMBEDDING_DIM}`);
    }
    return out;
  };

  return {
    name: `${model} (${dtype})`,
    dim: EMBEDDING_DIM,
    embed: async (text) => (await run([text]))[0],
    embedBatch: (texts) => (texts.length ? run(texts) : Promise.resolve([])),
  };
}

const STOP = new Set('a an and are at be by for from has have i in is it my of on or our the to was with not no very me we this that'.split(' '));

function hashEmbedder(): Embedder {
  const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const embed = async (text: string) => {
    const v = new Array<number>(EMBEDDING_DIM).fill(0);
    const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
    for (const w of words) {
      const stem = w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w;
      v[hash(stem) % EMBEDDING_DIM] += 1;
      for (let i = 0; i + 3 <= stem.length; i++) v[hash('#' + stem.slice(i, i + 3)) % EMBEDDING_DIM] += 0.3;
    }
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / n);
  };
  return { name: 'hash-bag-of-words (offline fallback, not semantic)', dim: EMBEDDING_DIM, embed, embedBatch: (t) => Promise.all(t.map(embed)) };
}

const g = globalThis as unknown as { __smEmbedder?: Embedder };

export function embedder(): Embedder {
  if (!g.__smEmbedder) {
    g.__smEmbedder = process.env.EMBEDDING_PROVIDER === 'hash' ? hashEmbedder() : transformersEmbedder();
  }
  return g.__smEmbedder;
}

export const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;

// ------------------------------------------------------------------ what gets embedded
export const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface WorkerText { bio: string | null; categories: string[]; trade?: string | null; skills?: string[] | null }

/** 'skill' row:  "{trade}. Services: {categories}. Skills: {skills}." */
export function skillText(w: WorkerText): string {
  const cats = w.categories.map(clean).filter(Boolean);
  const trade = clean(w.trade ?? '') || cats[0] || 'Service provider';
  const skills = (w.skills ?? []).map(clean).filter(Boolean);
  let t = `${trade}.`;
  if (cats.length) t += ` Services: ${cats.join(', ')}.`;
  if (skills.length) t += ` Skills: ${skills.join(', ')}.`;
  return t;
}

/** 'bio' row: the bio itself, or null when empty. */
export function bioText(w: WorkerText): string | null {
  const b = clean(w.bio ?? '');
  return b ? b : null;
}

// ------------------------------------------------------------------ storage helpers
/** Make worker_embedding_vector match the worker's current texts; only changed texts are re-embedded. */
export async function syncWorkerEmbeddings(db: Queryable, e: Embedder, workerId: number, w: WorkerText, force = false): Promise<number> {
  const wanted: { type: 'skill' | 'bio'; text: string }[] = [{ type: 'skill', text: skillText(w) }];
  const bio = bioText(w);
  if (bio) wanted.push({ type: 'bio', text: bio });

  const have = new Map(
    (await db.query<{ source_type: string; source_text: string }>(
      'SELECT source_type, source_text FROM worker_embedding_vector WHERE worker_id = $1', [workerId])).rows
      .map((r) => [r.source_type, r.source_text]),
  );
  const todo = force ? wanted : wanted.filter((x) => have.get(x.type) !== x.text);
  if (todo.length) {
    const vecs = await e.embedBatch(todo.map((x) => x.text));
    for (let i = 0; i < todo.length; i++) {
      await db.query(
        `INSERT INTO worker_embedding_vector (worker_id, source_type, source_text, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (worker_id, source_type)
         DO UPDATE SET source_text = EXCLUDED.source_text, embedding = EXCLUDED.embedding, updated_at = now()`,
        [workerId, todo[i].type, todo[i].text, toVectorLiteral(vecs[i])]);
    }
  }
  if (!bio && have.has('bio')) {
    await db.query(`DELETE FROM worker_embedding_vector WHERE worker_id = $1 AND source_type = 'bio'`, [workerId]);
  }
  return todo.length;
}

/** Worker texts from PostgreSQL (bio, categories); trade + skills are merged in from MongoDB by the caller. */
export async function loadWorkerTexts(db: Queryable, workerId?: number): Promise<(WorkerText & { worker_id: number })[]> {
  const { rows } = await db.query<{ worker_id: number; bio: string | null; categories: string[] }>(
    `SELECT w.worker_id, w.bio,
            coalesce(array_agg(c.name ORDER BY c.name) FILTER (WHERE c.name IS NOT NULL), '{}') AS categories
     FROM worker w
     LEFT JOIN worker_category wc ON wc.worker_id = w.worker_id
     LEFT JOIN service_category c ON c.category_id = wc.category_id
     WHERE $1::int IS NULL OR w.worker_id = $1
     GROUP BY w.worker_id ORDER BY w.worker_id`, [workerId ?? null]);
  return rows;
}

/** Embed every open request that has no embedding yet (seeded / demo requests). */
export async function embedMissingRequests(db: Queryable, e: Embedder): Promise<number> {
  const { rows } = await db.query<{ request_id: number; description: string }>(
    `SELECT r.request_id, r.description FROM service_request r
     LEFT JOIN request_embedding_vector v ON v.request_id = r.request_id
     WHERE r.status = 'open' AND v.request_id IS NULL ORDER BY r.request_id`);
  for (let i = 0; i < rows.length; i += 32) {
    const chunk = rows.slice(i, i + 32);
    const vecs = await e.embedBatch(chunk.map((r) => clean(r.description)));
    for (let j = 0; j < chunk.length; j++) {
      await db.query(
        `INSERT INTO request_embedding_vector (request_id, embedding) VALUES ($1, $2::vector) ON CONFLICT (request_id) DO NOTHING`,
        [chunk[j].request_id, toVectorLiteral(vecs[j])]);
    }
  }
  return rows.length;
}
