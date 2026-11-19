// Repairs drift between the three stores. PostgreSQL is the source of truth.
//   * worker without a MongoDB portfolio  -> minimal portfolio created (trade = first category)
//   * MongoDB portfolio without a worker  -> deleted (orphan)
//   * missing or stale embeddings         -> re-embedded
//   npm run db:reconcile                 repair
//   npm run db:reconcile -- --dry-run    report only
import './_env';
import { closePool, pool } from '../src/lib/db';
import { closeMongo, portfolios } from '../src/lib/mongo';
import { bioText, embedder, embedMissingRequests, loadWorkerTexts, skillText, syncWorkerEmbeddings } from '../src/lib/embeddings';

async function main() {
  const dry = process.argv.includes('--dry-run');
  const col = await portfolios();
  const workers = await loadWorkerTexts(pool());
  const ids = new Set(workers.map((w) => w.worker_id));
  const docs = new Map((await col.find({}, { projection: { _id: 0 } }).toArray()).map((d) => [d.worker_id, d]));

  const missing = workers.filter((w) => !docs.has(w.worker_id)).map((w) => w.worker_id);
  const orphans = [...docs.keys()].filter((id) => !ids.has(id));

  const { rows } = await pool().query<{ worker_id: number; source_type: string; source_text: string }>(
    'SELECT worker_id, source_type, source_text FROM worker_embedding_vector');
  const have = new Map(rows.map((r) => [`${r.worker_id}:${r.source_type}`, r.source_text]));
  const drift = workers.filter((w) => {
    const d = docs.get(w.worker_id);
    const texts = { ...w, trade: d?.trade ?? w.categories[0], skills: d?.trade_attributes.skills ?? [] };
    const bio = bioText(texts);
    return have.get(`${w.worker_id}:skill`) !== skillText(texts) || (bio ? have.get(`${w.worker_id}:bio`) !== bio : have.has(`${w.worker_id}:bio`));
  }).map((w) => w.worker_id);
  const { rows: [{ n: reqMissing }] } = await pool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM service_request r LEFT JOIN request_embedding_vector v USING (request_id)
     WHERE r.status = 'open' AND v.request_id IS NULL`);

  console.log({ workers: workers.length, missingPortfolios: missing, orphanPortfolios: orphans, embeddingDrift: drift, openRequestsWithoutEmbedding: reqMissing });
  if (dry) { console.log('(dry run: nothing changed)'); return; }

  for (const id of missing) {
    const w = workers.find((x) => x.worker_id === id)!;
    await col.insertOne({ worker_id: id, trade: w.categories[0] ?? 'Service provider', photos: [], certifications: [], trade_attributes: { skills: [] }, updated_at: new Date() });
  }
  if (orphans.length) await col.deleteMany({ worker_id: { $in: orphans } });
  const e = embedder();
  const fresh = new Map((await col.find({}, { projection: { _id: 0 } }).toArray()).map((d) => [d.worker_id, d]));
  for (const id of drift.concat(missing)) {
    const w = workers.find((x) => x.worker_id === id)!;
    const d = fresh.get(id);
    await syncWorkerEmbeddings(pool(), e, id, { ...w, trade: d?.trade, skills: d?.trade_attributes.skills });
  }
  const r = await embedMissingRequests(pool(), e);
  console.log(`repaired: ${missing.length} portfolios created, ${orphans.length} orphans removed, ${new Set(drift.concat(missing)).size} workers re-embedded, ${r} requests embedded`);
}

main().catch((err) => { console.error(`ERROR: ${err.message}`); process.exitCode = 1; })
  .finally(async () => { await closePool(); await closeMongo(); });
