// Rebuilds BOTH databases from scratch and loads the demo data.
//   npm run db:reset                 schema + seed + embeddings
//   npm run db:reset -- --no-embed   skip embeddings (run "npm run db:embed" later)
//   npm run db:reset -- --no-seed    schema only
// WARNING: deletes everything in the configured PostgreSQL database (public schema) and MongoDB database.
import './_env';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { MongoClient } from 'mongodb';
import { ensurePortfolioCollection, type PortfolioDoc } from '../src/lib/mongo';
import { embedder, embedMissingRequests, loadWorkerTexts, syncWorkerEmbeddings } from '../src/lib/embeddings';

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));
const SEED = !args.has('--no-seed');
const EMBED = SEED && !args.has('--no-embed');

interface SeedWorker {
  name: string; email: string; phone: string; locality: string; hourly_rate: number; status: 'verified' | 'pending';
  categories: string[]; bio: string;
  portfolio: { trade: string; certifications: PortfolioDoc['certifications']; trade_attributes: PortfolioDoc['trade_attributes'] };
}

const sqlFiles = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.sql')).sort().map((f) => join(dir, f));

async function main() {
  if (!process.env.POSTGRES_URL || !process.env.MONGODB_URI) {
    throw new Error('POSTGRES_URL and MONGODB_URI must be set. Copy .env.example to .env first.');
  }
  const t0 = Date.now();
  const pg = new Client({ connectionString: process.env.POSTGRES_URL });
  await pg.connect().catch((e) => { throw new Error(`Cannot connect to PostgreSQL at POSTGRES_URL (${e.message}). Is Docker running? Try: docker compose up -d`); });
  const mongo = await new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 }).connect()
    .catch((e) => { throw new Error(`Cannot connect to MongoDB at MONGODB_URI (${e.message}). Is Docker running? Try: docker compose up -d`); });

  try {
    console.log('PostgreSQL: resetting schema');
    await pg.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pg.query('CREATE SCHEMA public');
    await pg.query('GRANT ALL ON SCHEMA public TO public');
    for (const f of sqlFiles('db/postgres/migrations')) {
      process.stdout.write(`  migrate  ${f}\n`);
      await pg.query(readFileSync(join(ROOT, f), 'utf8'));
    }

    const mdb = mongo.db(process.env.MONGO_DB || undefined);
    console.log(`MongoDB: resetting collection worker_portfolio in database "${mdb.databaseName}"`);
    await mdb.collection('worker_portfolio').drop().catch(() => undefined);
    await ensurePortfolioCollection(mdb);

    if (SEED) {
      const [ref, ...rest] = sqlFiles('db/postgres/seed');
      console.log(`  seed     ${ref}`);
      await pg.query(readFileSync(join(ROOT, ref), 'utf8'));

      // Workers: PostgreSQL row + categories, and a MongoDB portfolio document, from ONE source file.
      const workers: SeedWorker[] = JSON.parse(readFileSync(join(ROOT, 'db/seed/workers.json'), 'utf8'));
      console.log(`  seed     db/seed/workers.json (${workers.length} workers -> PostgreSQL + MongoDB)`);
      const docs: PortfolioDoc[] = [];
      for (const w of workers) {
        const { rows } = await pg.query<{ worker_id: number }>(
          `INSERT INTO worker (name, email, phone, locality, bio, hourly_rate, verification_status, verified_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'pending' THEN NULL ELSE (SELECT min(admin_id) FROM admin) END)
           RETURNING worker_id`,
          [w.name, w.email, w.phone, w.locality, w.bio, w.hourly_rate, w.status]);
        await pg.query(
          `INSERT INTO worker_category (worker_id, category_id) SELECT $1, category_id FROM service_category WHERE name = ANY($2::text[])`,
          [rows[0].worker_id, w.categories]);
        docs.push({ worker_id: rows[0].worker_id, trade: w.portfolio.trade, photos: [], certifications: w.portfolio.certifications,
                    trade_attributes: w.portfolio.trade_attributes, updated_at: new Date() });
      }
      await mdb.collection<PortfolioDoc>('worker_portfolio').insertMany(docs);

      for (const f of rest) {
        console.log(`  seed     ${f}`);
        await pg.query(readFileSync(join(ROOT, f), 'utf8'));
      }
    }

    if (EMBED) {
      const e = embedder();
      console.log(`Embeddings: ${e.name} (the first run downloads the model, ~90 MB)`);
      const t = Date.now();
      const docs = new Map((await mdb.collection<PortfolioDoc>('worker_portfolio').find().toArray()).map((d) => [d.worker_id, d]));
      let n = 0;
      for (const w of await loadWorkerTexts(pg)) {
        const d = docs.get(w.worker_id);
        n += await syncWorkerEmbeddings(pg, e, w.worker_id, { ...w, trade: d?.trade, skills: d?.trade_attributes.skills }, true);
      }
      const r = await embedMissingRequests(pg, e);
      console.log(`  embedded ${n} worker texts and ${r} open requests in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    } else if (SEED) {
      console.log('Embeddings: skipped (--no-embed). Matching needs them: run "npm run db:embed".');
    }

    const { rows: [c] } = await pg.query(`SELECT
      (SELECT count(*) FROM worker) AS workers, (SELECT count(*) FROM customer) AS customers,
      (SELECT count(*) FROM availability_slot WHERE status = 'open') AS open_slots,
      (SELECT count(*) FROM booking) AS bookings, (SELECT count(*) FROM rating) AS ratings,
      (SELECT count(*) FROM worker_embedding_vector) AS worker_vectors, (SELECT count(*) FROM request_embedding_vector) AS request_vectors`);
    const portfoliosCount = await mdb.collection('worker_portfolio').countDocuments();
    console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    console.table({ ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number(v)])), mongo_portfolios: portfoliosCount });
  } finally {
    await pg.end();
    await mongo.close();
  }
}

main().catch((err) => { console.error(`\nERROR: ${err.message}`); process.exit(1); });
