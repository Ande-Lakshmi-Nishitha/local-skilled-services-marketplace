// End-to-end check of matching from the command line, compared with keyword search.
//   npm run try -- "AC not cooling, rattling noise"
// The test request is created inside a transaction that is rolled back (nothing is saved).
import './_env';
import { Client } from 'pg';
import { clean, embedder, toVectorLiteral } from '../src/lib/embeddings';
import { closePool } from '../src/lib/db';
import { keywordBaseline } from '../src/lib/services/requests';

async function main() {
  const text = process.argv.slice(2).join(' ').trim();
  if (!text) { console.error('usage: npm run try -- "what the customer types"'); process.exit(2); }
  const e = embedder();
  const t0 = Date.now();
  const vec = await e.embed(clean(text));
  const embedMs = Date.now() - t0;

  const c = new Client({ connectionString: process.env.POSTGRES_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    const { rows: [r] } = await c.query(`INSERT INTO service_request (customer_id, description) VALUES ((SELECT min(customer_id) FROM customer), $1) RETURNING request_id`, [text]);
    await c.query('INSERT INTO request_embedding_vector (request_id, embedding) VALUES ($1, $2::vector)', [r.request_id, toVectorLiteral(vec)]);
    const t1 = Date.now();
    const { rows } = await c.query(
      `SELECT m.*, w.name, string_agg(sc.name, '/') AS trade FROM fn_match_workers($1, 8) m
       JOIN worker w USING (worker_id) JOIN worker_category wc USING (worker_id) JOIN service_category sc USING (category_id)
       GROUP BY m.worker_id, m.similarity, m.trust_score, m.final_score, m.next_slot_id, m.next_slot_start, m.next_slot_end, w.name
       ORDER BY m.final_score DESC`, [r.request_id]);
    const matchMs = Date.now() - t1;
    await c.query('ROLLBACK');

    console.log(`\n"${text}"   (embedding ${embedMs} ms, matching query ${matchMs} ms, model ${e.name})\n`);
    console.log('SEMANTIC MATCHING (similarity + availability + Bayesian rating):');
    console.table(rows.map((m, i) => ({ rank: i + 1, worker: m.name, trade: m.trade, similarity: +Number(m.similarity).toFixed(3),
      trust: +Number(m.trust_score).toFixed(2), final: +Number(m.final_score).toFixed(3) })));
    const kw = await keywordBaseline(text);
    console.log('KEYWORD SEARCH (any word of the request in bio or category):');
    console.log(kw.length ? kw.slice(0, 8).map((k) => `  ${k.name}  [matched: ${k.matched.join(', ')}]`).join('\n') : '  no workers found');
  } finally {
    await c.end();
    await closePool();
  }
}

main().catch((err) => { console.error(`ERROR: ${err.message}`); process.exit(1); });
