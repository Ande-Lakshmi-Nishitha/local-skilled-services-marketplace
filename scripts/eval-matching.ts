// Evaluation: does semantic matching find the right kind of worker better than keyword search?
//
// Systems compared on the labelled queries in scripts/data/eval-queries.json:
//   1. keyword    words of the query appear in bio or category name (ILIKE), ranked by number of words matched
//   2. fulltext   PostgreSQL full-text search (to_tsvector / OR of query lexemes), ranked by ts_rank
//   3. semantic   fn_match_workers with alpha = 1 (similarity only)
//   4. sem+trust  fn_match_workers with the configured alpha (similarity + Bayesian rating)
// A result is relevant when the worker's category is in the query's label set.
// "hard" queries share NO word with the text of any relevant worker (vocabulary mismatch).
//
//   npm run eval                 table in the terminal + docs/evidence/eval-results.md
//   npm run eval -- --grid       also try several alpha / threshold values
import './_env';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Client } from 'pg';
import { clean, embedder, toVectorLiteral } from '../src/lib/embeddings';
import { keywordTerms, matchOptions } from '../src/lib/services/requests';

interface Q { q: string; relevant: string[]; tag?: string }
type Ranked = number[];   // worker ids, best first

const K = 10;
const queries: Q[] = JSON.parse(readFileSync('scripts/data/eval-queries.json', 'utf8'));

function metrics(ranked: Ranked, rel: Set<number>) {
  const firstHit = ranked.findIndex((id) => rel.has(id));
  return {
    hit1: firstHit === 0 ? 1 : 0,
    hit3: firstHit >= 0 && firstHit < 3 ? 1 : 0,
    p3: ranked.slice(0, 3).filter((id) => rel.has(id)).length / 3,
    mrr: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
    empty: ranked.length === 0 ? 1 : 0,
  };
}
type M = ReturnType<typeof metrics>;
const avg = (ms: M[]) => {
  const n = ms.length || 1;
  return { hit1: ms.reduce((s, m) => s + m.hit1, 0) / n, hit3: ms.reduce((s, m) => s + m.hit3, 0) / n,
           p3: ms.reduce((s, m) => s + m.p3, 0) / n, mrr: ms.reduce((s, m) => s + m.mrr, 0) / n, empty: ms.reduce((s, m) => s + m.empty, 0) };
};
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

async function main() {
  const grid = process.argv.includes('--grid');
  const c = new Client({ connectionString: process.env.POSTGRES_URL });
  await c.connect();
  const e = embedder();
  const opt = matchOptions();

  // worker id -> categories, and the text a keyword search can see
  const { rows: workers } = await c.query<{ worker_id: number; cats: string[]; hay: string }>(
    `SELECT w.worker_id, array_agg(sc.name) AS cats, lower(coalesce(w.bio,'') || ' ' || string_agg(sc.name, ' ')) AS hay
     FROM worker w JOIN worker_category wc USING (worker_id) JOIN service_category sc USING (category_id)
     WHERE w.verification_status = 'verified' GROUP BY w.worker_id`);
  const relevantSet = (labels: string[]) => new Set(workers.filter((w) => w.cats.some((x) => labels.includes(x))).map((w) => w.worker_id));
  const isHard = (q: Q) => {
    const terms = keywordTerms(q.q);
    return !workers.filter((w) => w.cats.some((x) => q.relevant.includes(x))).some((w) => terms.some((t) => w.hay.includes(t)));
  };

  const vecs = await e.embedBatch(queries.map((q) => clean(q.q)));
  const customer = (await c.query('SELECT min(customer_id) AS id FROM customer')).rows[0].id;

  const runSemantic = async (i: number, alpha: number, minSim: number): Promise<Ranked> => {
    await c.query('BEGIN');
    try {
      const { rows: [r] } = await c.query(`INSERT INTO service_request (customer_id, description) VALUES ($1, $2) RETURNING request_id`, [customer, queries[i].q]);
      await c.query('INSERT INTO request_embedding_vector (request_id, embedding) VALUES ($1, $2::vector)', [r.request_id, toVectorLiteral(vecs[i])]);
      const { rows } = await c.query('SELECT worker_id FROM fn_match_workers($1, $2, NULL, NULL, $3, $4, $5)', [r.request_id, K, alpha, minSim, opt.annCandidates]);
      return rows.map((x) => x.worker_id);
    } finally {
      await c.query('ROLLBACK');
    }
  };
  const runKeyword = async (q: Q): Promise<Ranked> => {
    const terms = keywordTerms(q.q);
    if (!terms.length) return [];
    return workers.map((w) => ({ id: w.worker_id, n: terms.filter((t) => w.hay.includes(t)).length }))
      .filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.id - b.id).slice(0, K).map((x) => x.id);
  };
  const runFullText = async (q: Q): Promise<Ranked> => {
    const terms = keywordTerms(q.q).map((t) => t.replace(/[^a-z0-9]/g, '')).filter(Boolean);
    if (!terms.length) return [];
    const { rows } = await c.query(
      `WITH d AS (
         SELECT w.worker_id, to_tsvector('english', coalesce(w.bio,'') || ' ' || string_agg(sc.name, ' ')) AS doc
         FROM worker w JOIN worker_category wc USING (worker_id) JOIN service_category sc USING (category_id)
         WHERE w.verification_status = 'verified' GROUP BY w.worker_id)
       SELECT worker_id FROM d, to_tsquery('english', $1) tq WHERE doc @@ tq
       ORDER BY ts_rank(doc, tq) DESC, worker_id LIMIT $2`, [terms.join(' | '), K]);
    return rows.map((r) => r.worker_id);
  };

  type Sys = 'keyword' | 'fulltext' | 'semantic' | 'sem+trust';
  const per: Record<Sys, M[]> = { keyword: [], fulltext: [], semantic: [], 'sem+trust': [] };
  const detail: string[] = [];
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const rel = relevantSet(q.relevant);
    const res: Record<Sys, Ranked> = {
      keyword: await runKeyword(q), fulltext: await runFullText(q),
      semantic: await runSemantic(i, 1, opt.minSimilarity), 'sem+trust': await runSemantic(i, opt.alpha, opt.minSimilarity),
    };
    for (const s of Object.keys(per) as Sys[]) per[s].push(metrics(res[s], rel));
    const mark = (r: Ranked) => (r.length ? (rel.has(r[0]) ? '✓' : '✗') : '–');
    detail.push(`| ${q.q} | ${q.relevant.join(', ')} | ${isHard(q) ? 'hard' : ''}${q.tag ? ` ${q.tag}` : ''} | ${mark(res.keyword)} | ${mark(res.fulltext)} | ${mark(res.semantic)} | ${mark(res['sem+trust'])} |`);
  }

  const subsets: [string, (q: Q) => boolean][] = [
    ['all queries', () => true],
    ['hard (no shared words)', (q) => isHard(q)],
    ['English, not hard', (q) => !isHard(q) && !q.tag],
    ['Hinglish', (q) => q.tag === 'hinglish'],
  ];
  const lines: string[] = [];
  const out = (s = '') => { console.log(s); lines.push(s); };
  out(`# Matching evaluation`);
  out();
  out(`Model: ${e.name}. Verified workers: ${workers.length}. Queries: ${queries.length}. alpha = ${opt.alpha}, similarity threshold = ${opt.minSimilarity}.`);
  out(`Relevant = worker's category is in the query's label set. Generated by \`npm run eval\` on ${new Date().toISOString().slice(0, 10)}.`);
  for (const [name, f] of subsets) {
    const idx = queries.map((q, i) => (f(q) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    out();
    out(`## ${name} (${idx.length} queries)`);
    out();
    out('| system | hit@1 | hit@3 | precision@3 | MRR | no result |');
    out('|---|---|---|---|---|---|');
    for (const s of Object.keys(per) as Sys[]) {
      const a = avg(idx.map((i) => per[s][i]));
      out(`| ${s} | ${pct(a.hit1)} | ${pct(a.hit3)} | ${pct(a.p3)} | ${a.mrr.toFixed(2)} | ${a.empty} |`);
    }
  }

  if (grid) {
    out();
    out('## Tuning grid (sem+trust, all English queries): MRR / hit@1');
    out();
    const eng = queries.map((q, i) => (q.tag ? -1 : i)).filter((i) => i >= 0);
    const alphas = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
    const sims = [0.15, 0.25, 0.35];
    out(`| alpha \\ threshold | ${sims.join(' | ')} |`);
    out(`|---|${sims.map(() => '---').join('|')}|`);
    for (const a of alphas) {
      const cells: string[] = [];
      for (const s of sims) {
        const ms: M[] = [];
        for (const i of eng) ms.push(metrics(await runSemantic(i, a, s), relevantSet(queries[i].relevant)));
        const r = avg(ms);
        cells.push(`${r.mrr.toFixed(2)} / ${pct(r.hit1)}${r.empty ? ` (${r.empty} empty)` : ''}`);
      }
      out(`| ${a} | ${cells.join(' | ')} |`);
    }
  }

  out();
  out('## Per query (top result relevant?)');
  out();
  out('| query | relevant categories | type | keyword | fulltext | semantic | sem+trust |');
  out('|---|---|---|---|---|---|---|');
  detail.forEach((d) => out(d));

  mkdirSync('docs/evidence', { recursive: true });
  writeFileSync('docs/evidence/eval-results.md', lines.join('\n') + '\n');
  console.log('\nSaved to docs/evidence/eval-results.md');
  await c.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
