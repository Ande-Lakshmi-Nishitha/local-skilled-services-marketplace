// MongoDB access: one collection, worker_portfolio, one document per worker.
// worker_id is a LOGICAL reference to PostgreSQL worker.worker_id (no foreign keys across databases).
import { MongoClient, type Collection, type Db } from 'mongodb';

export interface PortfolioPhoto { url: string; caption?: string; uploaded_at?: Date }
export interface Certification { name: string; issuer?: string; number?: string; issued_year?: number }

export interface PortfolioDoc {
  worker_id: number;
  trade: string;
  photos: PortfolioPhoto[];
  certifications: Certification[];
  /** Free-form, different for every trade. `skills: string[]` is the one key every trade shares. */
  trade_attributes: Record<string, unknown> & { skills?: string[] };
  updated_at: Date;
}

const g = globalThis as unknown as { __smMongo?: Promise<MongoClient> };

export function mongoClient(): Promise<MongoClient> {
  if (!g.__smMongo) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set (copy .env.example to .env)');
    g.__smMongo = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }).connect().catch((err) => {
      g.__smMongo = undefined;   // allow a retry on the next call
      throw err;
    });
  }
  return g.__smMongo;
}

export async function mongoDb(): Promise<Db> {
  return (await mongoClient()).db(process.env.MONGO_DB || undefined);
}

export async function portfolios(): Promise<Collection<PortfolioDoc>> {
  return (await mongoDb()).collection<PortfolioDoc>('worker_portfolio');
}

export async function closeMongo(): Promise<void> {
  if (g.__smMongo) {
    const c = await g.__smMongo.catch(() => null);
    g.__smMongo = undefined;
    await c?.close();
  }
}

/** JSON-schema validator: only the fields every trade shares are enforced. */
export const PORTFOLIO_VALIDATOR = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['worker_id', 'trade', 'photos', 'certifications', 'trade_attributes', 'updated_at'],
    properties: {
      worker_id: { bsonType: ['int', 'long'], description: 'logical reference to PostgreSQL worker.worker_id' },
      trade: { bsonType: 'string', minLength: 2 },
      photos: {
        bsonType: 'array',
        items: { bsonType: 'object', required: ['url'], properties: { url: { bsonType: 'string' }, caption: { bsonType: 'string' } } },
      },
      certifications: {
        bsonType: 'array',
        items: { bsonType: 'object', required: ['name'], properties: { name: { bsonType: 'string' } } },
      },
      trade_attributes: {
        bsonType: 'object',
        properties: { skills: { bsonType: 'array', items: { bsonType: 'string' } } },
      },
      updated_at: { bsonType: 'date' },
    },
  },
};

/** Create the collection with its validator and indexes (idempotent). */
export async function ensurePortfolioCollection(db: Db): Promise<void> {
  const exists = (await db.listCollections({ name: 'worker_portfolio' }).toArray()).length > 0;
  if (!exists) {
    await db.createCollection('worker_portfolio', { validator: PORTFOLIO_VALIDATOR, validationLevel: 'strict', validationAction: 'error' });
  } else {
    await db.command({ collMod: 'worker_portfolio', validator: PORTFOLIO_VALIDATOR, validationLevel: 'strict' });
  }
  const col = db.collection('worker_portfolio');
  await col.createIndex({ worker_id: 1 }, { unique: true });
  await col.createIndex({ trade: 1 });
}
