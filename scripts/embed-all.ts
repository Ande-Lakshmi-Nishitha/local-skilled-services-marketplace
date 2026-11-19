// (Re-)embeds every worker (skill + bio rows) and every open request without an embedding.
//   npm run db:embed               only texts that changed
//   npm run db:embed -- --force    everything (after changing the model or the text format)
import './_env';
import { closePool, pool } from '../src/lib/db';
import { closeMongo, portfolios } from '../src/lib/mongo';
import { embedder, embedMissingRequests, loadWorkerTexts, syncWorkerEmbeddings } from '../src/lib/embeddings';

async function main() {
  const force = process.argv.includes('--force');
  const e = embedder();
  const t = Date.now();
  const workers = await loadWorkerTexts(pool());
  const docs = new Map((await (await portfolios()).find().toArray()).map((d) => [d.worker_id, d]));
  let n = 0;
  for (const w of workers) {
    const d = docs.get(w.worker_id);
    n += await syncWorkerEmbeddings(pool(), e, w.worker_id, { ...w, trade: d?.trade, skills: d?.trade_attributes.skills }, force);
  }
  const r = await embedMissingRequests(pool(), e);
  console.log(`model: ${e.name}`);
  console.log(`workers: ${workers.length}, texts embedded: ${n}${force ? ' (forced)' : ' (only changed ones)'}`);
  console.log(`open requests embedded: ${r}`);
  console.log(`took ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

main().catch((err) => { console.error(`ERROR: ${err.message}`); process.exitCode = 1; })
  .finally(async () => { await closePool(); await closeMongo(); });
